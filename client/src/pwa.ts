import { useCallback, useEffect, useState } from 'react';

/**
 * Панель как приложение (PWA): регистрация сервис-воркера и определение способа установки.
 * Сервис-воркер работает только в защищённом контексте (HTTPS или localhost) — по http://IP его нет, но «добавить на экран» в iOS и
 * ярлык в Android остаются (docs/pwa.md).
 */

export type Platform = 'ios' | 'android' | 'other';

interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

export function detectPlatform(nav: NavigatorLike = navigator): Platform {
  const ua = nav.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  // iPadOS 13+ выдаёт себя за Mac, но у него есть сенсорный экран
  if (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // самоподписанный сертификат или запрет браузера: панель работает и без воркера
    });
  });
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallApp {
  platform: Platform;
  /** Панель уже открыта как приложение */
  standalone: boolean;
  /** HTTPS или localhost: без него браузер не установит приложение и не запустит сервис-воркер */
  secure: boolean;
  /** Браузер сам предлагает установку (Chrome/Edge/Samsung Internet): достаточно вызвать install() */
  canPrompt: boolean;
  /** Показывать ли кнопку «Установить»: на телефоне всегда (с подсказкой), на компьютере — когда браузер предлагает сам */
  visible: boolean;
  /** Системный диалог установки; false — пользователь отказался */
  install: () => Promise<boolean>;
}

export function useInstallApp(): InstallApp {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(isStandalone);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Своё место для кнопки вместо мини-панели браузера
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    const query = window.matchMedia?.('(display-mode: standalone)');
    const onMode = () => setStandalone(isStandalone());
    query?.addEventListener?.('change', onMode);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      query?.removeEventListener?.('change', onMode);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return false;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    // Событие одноразовое: после показа диалога повторно использовать его нельзя
    setDeferred(null);
    return choice.outcome === 'accepted';
  }, [deferred]);

  const platform = detectPlatform();
  return {
    platform,
    standalone,
    secure: typeof window !== 'undefined' && window.isSecureContext,
    canPrompt: deferred !== null,
    visible: !standalone && (deferred !== null || platform !== 'other'),
    install,
  };
}
