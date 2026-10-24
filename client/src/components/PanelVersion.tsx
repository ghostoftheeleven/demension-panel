import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import type { VersionInfo } from '../types';
import { api } from '../api';

/** Как часто интерфейс спрашивает версию (сервер сам кэширует ответ GitHub на 6 часов) */
const POLL_MS = 60 * 60 * 1000;

function describe(info: VersionInfo): string {
  if (!info.check_enabled) return 'Проверка обновлений отключена (DEMENSION_UPDATE_CHECK=0)';
  const checked = info.checked_at ? `Проверено: ${new Date(info.checked_at).toLocaleString('ru-RU')}` : '';
  if (info.error && !info.latest) return [info.error, checked].filter(Boolean).join('\n');
  const latest = info.latest ? `Последняя версия на GitHub: ${info.latest}` : '';
  const status = info.update_available ? 'Доступно обновление' : info.latest ? 'Установлена актуальная версия' : '';
  return [latest, status, info.error, checked, 'Нажмите, чтобы проверить сейчас'].filter(Boolean).join('\n');
}

/**
 * Текущая версия панели и последняя версия из релизов GitHub
 */
export const PanelVersion: React.FC = () => {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback((refresh: boolean) => {
    setChecking(true);
    api
      .getVersion(refresh)
      .then(setInfo)
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchVersion = () => {
      api.getVersion().then((data) => !cancelled && setInfo(data)).catch(() => {});
    };
    fetchVersion();
    const interval = setInterval(fetchVersion, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!info) return null;

  return (
    <div className="flex items-center gap-1.5 text-[10px] leading-4 whitespace-nowrap">
      <button
        type="button"
        onClick={() => load(true)}
        title={describe(info)}
        className="flex items-center gap-1 font-mono text-zinc-500 hover:text-zinc-300 transition"
      >
        <span>{info.current}</span>
        {checking && <RefreshCw className="w-3 h-3 animate-spin" />}
      </button>
      {info.latest && !info.update_available && (
        <span title={describe(info)} className="text-emerald-400/80">
          актуальная (GitHub: {info.latest})
        </span>
      )}
      {!info.latest && info.check_enabled && (
        <span title={describe(info)} className="text-zinc-600">
          GitHub: —
        </span>
      )}
      {info.update_available && info.latest && (
        <a
          href={info.latest_url || info.releases_url}
          target="_blank"
          rel="noopener noreferrer"
          title="Что нового и как обновить"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 transition"
        >
          <ArrowUpCircle className="w-3 h-3" />
          <span>Доступна {info.latest}</span>
        </a>
      )}
    </div>
  );
};
