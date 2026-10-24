import React, { useEffect, useRef, useState } from 'react';
import { Terminal, CheckCircle2, AlertCircle, X, Loader2 } from 'lucide-react';
import type { Server } from '../types';
import { getToken } from '../api';

interface InstallLogsModalProps {
  isOpen: boolean;
  server: Server | null;
  onClose: () => void;
  onFinished: () => void;
}

export const InstallLogsModal: React.FC<InstallLogsModalProps> = ({
  isOpen,
  server,
  onClose,
  onFinished,
}) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'running' | 'success' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!isOpen || !server) return;

    setLogs([]);
    setStatus('connecting');
    setErrorMessage(null);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    let finished = false;

    // Токен передаётся первым сообщением, а не в URL
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_ok') {
          setStatus('running');
          ws.send(JSON.stringify({ type: 'start_install', serverId: server.id }));
        } else if (msg.type === 'log') {
          setLogs((prev) => [...prev, msg.data]);
        } else if (msg.type === 'install_finished') {
          finished = true;
          if (msg.result?.success) {
            setStatus('success');
            onFinishedRef.current();
          } else {
            setStatus('error');
            setErrorMessage(msg.result?.error || 'Произошла ошибка при установке');
            onFinishedRef.current();
          }
        } else if (msg.type === 'error') {
          finished = true;
          setStatus('error');
          setErrorMessage(msg.message);
          onFinishedRef.current();
        }
      } catch {
        setLogs((prev) => [...prev, event.data]);
      }
    };

    ws.onerror = () => {
      if (finished) return;
      setStatus('error');
      setErrorMessage('Не удалось установить WebSocket соединение с панелью');
    };

    ws.onclose = () => {
      if (finished) return;
      finished = true;
      setStatus('error');
      setErrorMessage('Соединение с панелью прервано. Установка могла продолжиться на сервере — проверьте его статус через минуту.');
      onFinishedRef.current();
    };

    return () => {
      finished = true;
      ws.close();
    };
  }, [isOpen, server]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  if (!isOpen || !server) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col h-[75vh] overflow-hidden">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <span>Установка AmneziaWG на {server.name}</span>
                <span className="text-zinc-500 font-mono text-xs">({server.host})</span>
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {status === 'running' && (
              <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-full border border-amber-400/20">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Установка...</span>
              </div>
            )}
            {status === 'success' && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-400/10 px-2.5 py-1 rounded-full border border-emerald-400/20">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Успешно завершено</span>
              </div>
            )}
            {status === 'error' && (
              <div className="flex items-center gap-1.5 text-xs text-red-400 bg-red-400/10 px-2.5 py-1 rounded-full border border-red-400/20">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>Ошибка</span>
              </div>
            )}

            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-white transition p-1 rounded-lg hover:bg-zinc-800"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Terminal Console */}
        <div
          ref={logContainerRef}
          className="flex-1 p-5 font-mono text-xs text-zinc-300 overflow-y-auto bg-black/90 space-y-1 select-text leading-relaxed whitespace-pre-wrap"
        >
          {logs.length === 0 && status === 'connecting' && (
            <div className="text-zinc-500 italic">Подключение к удаленному серверу по SSH...</div>
          )}

          {logs.map((log, index) => {
            const isError = log.toLowerCase().includes('ошибка') || log.toLowerCase().includes('error');
            const isSuccess = log.includes('УСПЕХ') || log.includes('готово') || log.includes('🎉');
            const isHeader = log.includes('[') && log.includes(']');

            return (
              <div
                key={index}
                className={
                  isError
                    ? 'text-red-400'
                    : isSuccess
                    ? 'text-emerald-400 font-semibold'
                    : isHeader
                    ? 'text-cyan-400 font-medium'
                    : 'text-zinc-300'
                }
              >
                {log}
              </div>
            );
          })}

          {errorMessage && (
            <div className="text-red-400 bg-red-950/40 border border-red-800/40 p-3 rounded-lg my-2">
              {errorMessage}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-800 bg-zinc-900/40 flex items-center justify-between text-xs text-zinc-500">
          <span>Поддерживаемые ОС: Ubuntu 20.04+, Debian 11+, AlmaLinux 9+</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg transition font-medium"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
