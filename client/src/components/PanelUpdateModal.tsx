import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpCircle, Loader2, CheckCircle2, AlertTriangle, ExternalLink, RotateCcw, Terminal } from 'lucide-react';
import type { PanelUpdateStatus, VersionInfo } from '../types';
import { api } from '../api';

interface PanelUpdateModalProps {
  info: VersionInfo;
  onClose: () => void;
}

/** Как часто спрашивать состояние, пока идёт обновление */
const POLL_MS = 3000;
const INSTALL_COMMAND = 'curl -sSL https://raw.githubusercontent.com/ghostoftheeleven/demension-panel/main/install.sh | sudo bash';

/**
 * Обновление панели до последнего релиза прямо из интерфейса. Обновление выполняет сервер (install.sh в отдельной службе
 * systemd): панель перезапускается, поэтому на время сборки запросы к ней не проходят — это ожидаемо.
 */
export const PanelUpdateModal: React.FC<PanelUpdateModalProps> = ({ info, onClose }) => {
  const [status, setStatus] = useState<PanelUpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Панель не отвечает: идёт сборка или перезапуск службы
  const [restarting, setRestarting] = useState(false);
  const [watching, setWatching] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getPanelUpdate();
      setStatus(next);
      setLoadError(null);
      setRestarting(false);
      return next;
    } catch (err: any) {
      if (watching) setRestarting(true);
      else setLoadError(err.message || 'Не удалось получить состояние обновления');
      return null;
    }
  }, [watching]);

  useEffect(() => {
    load().then((s) => s?.state === 'running' && setWatching(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(async () => {
      const next = await load();
      if (next && next.state !== 'running') setWatching(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [watching, load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log]);

  const done = status?.state === 'success' && !watching && status.to === info.latest && status.to === status.current;
  // Новая версия интерфейса: страницу нужно перезагрузить
  const reloadNeeded = done && status.current !== info.current;
  useEffect(() => {
    if (!reloadNeeded) return;
    const timer = setTimeout(() => window.location.reload(), 4000);
    return () => clearTimeout(timer);
  }, [reloadNeeded]);

  const start = async () => {
    if (!info.latest) return;
    setStarting(true);
    setLoadError(null);
    try {
      setStatus(await api.startPanelUpdate(info.latest));
      setWatching(true);
      setConfirm(false);
    } catch (err: any) {
      setLoadError(err.message || 'Не удалось запустить обновление');
      load();
    } finally {
      setStarting(false);
    }
  };

  const running = watching || status?.state === 'running';
  const canClose = !running;
  const showResult = status && !running && status.state !== 'idle' && (status.to === info.latest || status.state !== 'success');

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-semibold text-white">Обновление панели</h2>
          </div>
          <button
            onClick={onClose}
            disabled={!canClose}
            title={canClose ? 'Закрыть' : 'Дождитесь окончания обновления'}
            className="text-zinc-400 hover:text-white transition p-1 rounded-lg hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <div className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-zinc-950/60 border border-zinc-800">
            <div>
              <div className="text-[11px] text-zinc-500">Установлена</div>
              <div className="font-mono text-sm text-zinc-200">{status?.current ?? info.current}</div>
            </div>
            <div className="text-zinc-600">→</div>
            <div className="text-right">
              <div className="text-[11px] text-zinc-500">Последний релиз</div>
              <div className="font-mono text-sm text-emerald-300">{info.latest ?? '—'}</div>
            </div>
          </div>

          {info.latest_url && (
            <a
              href={info.latest_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Что нового в {info.latest}
            </a>
          )}

          {loadError && (
            <div className="flex gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{loadError}</span>
            </div>
          )}

          {running && (
            <div className="flex gap-3 p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/20">
              <Loader2 className="w-5 h-5 text-emerald-400 animate-spin shrink-0" />
              <div className="text-xs text-zinc-300 space-y-1">
                <div className="font-medium text-white">
                  {restarting ? 'Панель перезапускается…' : `Обновление до ${status?.to ?? info.latest}…`}
                </div>
                <div className="text-zinc-400">
                  Обычно занимает 1–3 минуты: скачивание релиза, резервная копия БД, сборка, перезапуск службы. Пока панель
                  перезапускается, она не отвечает — не закрывайте страницу.
                </div>
              </div>
            </div>
          )}

          {done && (
            <div className="flex gap-3 p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <div className="text-xs text-zinc-300 space-y-2">
                <div className="font-medium text-white">Панель обновлена до {status.current}</div>
                <div>Данные, ноды, клиенты и подписки сохранены. Страница перезагрузится, чтобы загрузить новый интерфейс.</div>
                <button
                  onClick={() => window.location.reload()}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500 text-zinc-950 font-semibold hover:bg-emerald-400 transition"
                >
                  Перезагрузить страницу
                </button>
              </div>
            </div>
          )}

          {showResult && !done && (
            <div className="flex gap-3 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20">
              {status.state === 'rolled_back' ? (
                <RotateCcw className="w-5 h-5 text-amber-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
              )}
              <div className="text-xs text-zinc-300 space-y-1">
                <div className="font-medium text-white">
                  {status.state === 'rolled_back' ? 'Обновление отменено' : status.state === 'success' ? 'Последнее обновление' : 'Обновление не удалось'}
                </div>
                {status.message && <div>{status.message}</div>}
                {status.finished_at && <div className="text-zinc-500">{new Date(status.finished_at).toLocaleString('ru-RU')}</div>}
              </div>
            </div>
          )}

          {status && !status.available && !running && (
            <div className="space-y-2 p-4 rounded-2xl bg-zinc-950/60 border border-zinc-800 text-xs text-zinc-400">
              <div className="flex items-center gap-2 text-zinc-200 font-medium">
                <Terminal className="w-4 h-4" />
                Обновление из панели недоступно
              </div>
              <div>{status.reason}</div>
              <div>Обновите панель из терминала сервера — повторный запуск установки сохраняет все данные:</div>
              <code className="block p-2 rounded-lg bg-black/60 border border-zinc-800 text-[11px] text-emerald-300 break-all select-all">
                {INSTALL_COMMAND}
              </code>
            </div>
          )}

          {status?.log && (
            <details open={running || status.state === 'failed' || status.state === 'rolled_back'} className="group">
              <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200 select-none">Журнал обновления</summary>
              <pre
                ref={logRef}
                className="mt-2 max-h-64 overflow-auto p-3 rounded-xl bg-black/60 border border-zinc-800 text-[10.5px] leading-4 text-zinc-400 whitespace-pre-wrap break-all"
              >
                {status.log}
              </pre>
            </details>
          )}
        </div>

        {status?.available && info.update_available && info.latest && !running && !done && (
          <div className="px-6 py-4 border-t border-zinc-800 bg-zinc-900/60 space-y-3">
            {confirm ? (
              <>
                <div className="text-xs text-zinc-400">
                  Панель будет недоступна 1–3 минуты. Логин, пароль, ноды, клиенты, подписки и настройки сохранятся; перед
                  обновлением делается резервная копия БД, а если новая версия не запустится — панель вернётся на {info.current}.
                  VPN у пользователей не прерывается: ноды работают независимо от панели.
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setConfirm(false)}
                    className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 transition"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={start}
                    disabled={starting}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-500 text-zinc-950 hover:bg-emerald-400 transition disabled:opacity-60"
                  >
                    {starting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Обновить сейчас
                  </button>
                </div>
              </>
            ) : (
              <div className="flex justify-end">
                <button
                  onClick={() => setConfirm(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-500 text-zinc-950 hover:bg-emerald-400 transition"
                >
                  <ArrowUpCircle className="w-4 h-4" />
                  Обновить до {info.latest}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
