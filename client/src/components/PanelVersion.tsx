import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import type { VersionInfo } from '../types';
import { api } from '../api';
import { PanelUpdateModal } from './PanelUpdateModal';

/** Как часто интерфейс спрашивает версию (сервер сам кэширует ответ GitHub на 6 часов) */
const POLL_MS = 60 * 60 * 1000;

function describe(info: VersionInfo): string {
  if (!info.check_enabled) return 'Проверка обновлений отключена (DEMENTIA_UPDATE_CHECK=0)';
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
  const [updateOpen, setUpdateOpen] = useState(false);

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
        className="flex items-center gap-1 font-mono text-faint hover:text-ink transition"
      >
        <span>{info.current}</span>
        {checking && <RefreshCw className="w-3 h-3 animate-spin" />}
      </button>
      {info.latest && !info.update_available && (
        <span title={describe(info)} className="text-ok">
          актуальная (GitHub: {info.latest})
        </span>
      )}
      {!info.latest && info.check_enabled && (
        <span title={describe(info)} className="text-faint">
          GitHub: —
        </span>
      )}
      {info.update_available && info.latest && (
        <button
          type="button"
          onClick={() => setUpdateOpen(true)}
          title="Что нового и обновление панели"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-warn-soft text-warn border border-line hover:bg-warn-soft transition"
        >
          <ArrowUpCircle className="w-3 h-3" />
          <span>Доступна {info.latest}</span>
        </button>
      )}
      {updateOpen && <PanelUpdateModal info={info} onClose={() => setUpdateOpen(false)} />}
    </div>
  );
};
