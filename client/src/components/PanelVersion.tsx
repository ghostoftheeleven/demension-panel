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
  /** Итог проверки по кнопке: показывается рядом несколько секунд (иначе нажатие выглядит так, будто ничего не произошло) */
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const check = useCallback(() => {
    setChecking(true);
    setResult(null);
    api
      .getVersion(true)
      .then((data) => {
        setInfo(data);
        if (data.error) setResult({ ok: false, text: data.error.replace(/^Не удалось проверить обновления: /, 'ошибка: ') });
        else if (data.update_available) setResult(null);
        else setResult({ ok: true, text: 'обновлений нет' });
      })
      .catch((err) => setResult({ ok: false, text: `ошибка: ${err.message}` }))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), result.ok ? 4000 : 10000);
    return () => clearTimeout(timer);
  }, [result]);

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
        onClick={check}
        disabled={checking || !info.check_enabled}
        title={describe(info)}
        className="group flex items-center gap-1.5 text-faint hover:text-ink disabled:cursor-default transition"
      >
        <span className="font-mono">{info.current}</span>
        {info.latest && !info.update_available && <span className="text-ok">актуальная (GitHub: {info.latest})</span>}
        {!info.latest && info.check_enabled && <span className={info.error ? 'text-bad' : ''}>GitHub: {info.error ? 'нет ответа' : '—'}</span>}
        {info.check_enabled && <RefreshCw className={`w-3 h-3 ${checking ? 'animate-spin' : 'opacity-0 group-hover:opacity-100'}`} />}
      </button>
      {result && (
        <span className={`max-w-[260px] truncate ${result.ok ? 'text-ok' : 'text-bad'}`} title={result.text}>
          {result.text}
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
