import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { detectPlatform, useInstallApp } from './pwa';

const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
const manifest = JSON.parse(read('../public/manifest.webmanifest').toString('utf8'));
const html = read('../index.html').toString('utf8');

/** Размер PNG из заголовка IHDR (ширина и высота — по 4 байта с 16-го) */
const pngSize = (rel: string) => {
  const buf = read(rel);
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

describe('манифест и мета-теги', () => {
  it('содержит то, без чего Chrome не предложит установку', () => {
    expect(manifest).toMatchObject({ name: 'Dementia Panel', start_url: '/', scope: '/', display: 'standalone', lang: 'ru' });
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.icons.some((i: { sizes: string; purpose: string }) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(manifest.icons.some((i: { sizes: string; purpose: string }) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
  });

  it('каждая иконка из манифеста существует и имеет заявленный размер', () => {
    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(`../public${icon.src}`), icon.src).toEqual([w, h]);
    }
    expect(pngSize('../public/apple-touch-icon.png')).toEqual([180, 180]);
  });

  it('цвета манифеста совпадают с theme-color страницы и фоном темы', () => {
    const theme = /name="theme-color" content="([^"]+)"/.exec(html)?.[1];
    expect(theme).toBe(manifest.theme_color);
    expect(manifest.background_color).toBe(manifest.theme_color);
    expect(read('./index.css').toString('utf8')).toContain(`--color-page: ${theme}`);
  });

  it('страница подключает манифест, иконку iOS и безопасные зоны', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    // Масштабирование жестами не отключаем (доступность)
    expect(html).not.toMatch(/user-scalable\s*=\s*no|maximum-scale/);
  });
});

describe('detectPlatform', () => {
  it('различает iOS, iPadOS (под видом Mac), Android и остальное', () => {
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe('ios');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('ios');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe('other');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120' })).toBe('android');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' })).toBe('other');
  });
});

describe('useInstallApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const promptEvent = (outcome: 'accepted' | 'dismissed') => {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    event.prompt = vi.fn(async () => {});
    event.userChoice = Promise.resolve({ outcome });
    return event;
  };

  it('на компьютере кнопки нет, пока браузер не предложил установку; после предложения — есть, и install() вызывает системный диалог', async () => {
    const { result } = renderHook(() => useInstallApp());
    expect(result.current.visible).toBe(false);

    const event = promptEvent('accepted');
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(result.current.canPrompt).toBe(true);
    expect(result.current.visible).toBe(true);

    let accepted = false;
    await act(async () => {
      accepted = await result.current.install();
    });
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(accepted).toBe(true);
    // Событие одноразовое
    expect(result.current.canPrompt).toBe(false);
  });

  it('отказ пользователя возвращает false', async () => {
    const { result } = renderHook(() => useInstallApp());
    act(() => {
      window.dispatchEvent(promptEvent('dismissed'));
    });
    let accepted = true;
    await act(async () => {
      accepted = await result.current.install();
    });
    expect(accepted).toBe(false);
  });

  it('после установки (appinstalled) кнопка исчезает', () => {
    const { result } = renderHook(() => useInstallApp());
    act(() => {
      window.dispatchEvent(promptEvent('accepted'));
    });
    expect(result.current.visible).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current.standalone).toBe(true);
    expect(result.current.visible).toBe(false);
  });

  it('в режиме приложения (display-mode: standalone) кнопки нет', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('standalone'), media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
    );
    const { result } = renderHook(() => useInstallApp());
    expect(result.current.standalone).toBe(true);
    expect(result.current.visible).toBe(false);
  });
});
