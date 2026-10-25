import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, Copy, Download, Loader2, KeyRound, XCircle, AlertTriangle, Check } from 'lucide-react';
import type { MigrationStatus } from '../types';
import { api } from '../api';
import { copyToClipboard } from '../utils';

const INSTALL_COMMAND = 'curl -sSL https://raw.githubusercontent.com/ghostoftheeleven/demension-panel/main/install.sh | sudo bash';

const inputClass =
  'w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm';

const CopyRow: React.FC<{ label: string; value: string; secret?: boolean }> = ({ label, value, secret }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      alert(value);
    }
  };
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <button
        type="button"
        onClick={copy}
        className="w-full flex items-center gap-2 text-left bg-zinc-950 border border-zinc-800 hover:border-emerald-500/40 rounded-xl px-3 py-2 transition"
        title="Скопировать"
      >
        <span className={`flex-1 font-mono break-all ${secret ? 'text-lg tracking-widest text-emerald-300' : 'text-xs text-zinc-200'}`}>{value}</span>
        {copied ? <Check className="w-4 h-4 text-emerald-400 flex-shrink-0" /> : <Copy className="w-4 h-4 text-zinc-500 flex-shrink-0" />}
      </button>
    </div>
  );
};

/**
 * Перенос панели на другой сервер (docs/migration.md): код переноса, команда для нового сервера, архив файлом, отмена.
 */
export const MigrationCard: React.FC<{ publicUrl: string | null; onStateChange?: () => void }> = ({ publicUrl, onStateChange }) => {
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Код показывается один раз и живёт только в памяти этой страницы
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    api.getMigrationStatus().then(setStatus).catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  if (!status) return null;

  const panelAddress = (publicUrl || window.location.origin).replace(/\/+$/, '');

  const handlePrepare = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.prepareMigration(password);
      setIssued(result);
      setPassword('');
      setAsking(false);
      load();
      onStateChange?.();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    const exporting = status.state === 'exporting';
    const text = exporting
      ? 'Архив уже передан на новый сервер. Отмена вернёт эту панель в обычный режим; если новая панель уже запущена, обе будут управлять одними нодами. Отменить перенос?'
      : 'Отменить перенос? Выданный код перестанет действовать.';
    if (!window.confirm(text)) return;
    setBusy(true);
    try {
      await api.cancelMigration();
      setIssued(null);
      setMessage({ type: 'success', text: 'Перенос отменён, панель работает в обычном режиме.' });
      load();
      onStateChange?.();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.downloadMigrationArchive();
      setMessage({
        type: 'success',
        text: 'Архив скачан. Теперь изменения в этой панели блокируются до завершения или отмены переноса. На новом сервере в установщике укажите путь к файлу и код переноса.',
      });
      load();
      onStateChange?.();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const expires = status.expiresAt ? new Date(status.expiresAt).toLocaleString() : '';

  return (
    <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-3xl p-6 sm:p-8 shadow-xl space-y-6">
      <div className="flex items-center gap-3 pb-4 border-b border-zinc-800/80">
        <div className="w-10 h-10 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
          <ArrowRightLeft className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white tracking-wide">Перенос панели на другой сервер</h2>
          <p className="text-xs text-zinc-400">
            Администратор, ноды, клиенты, пользователи, подписки, партнёры и ключ шифрования переезжают целиком
          </p>
        </div>
      </div>

      {message && (
        <div
          className={`p-3 rounded-xl border text-xs ${
            message.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              : 'bg-red-500/10 border-red-500/20 text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      {status.state === 'migrated' && (
        <div className="p-3 rounded-xl border bg-amber-500/10 border-amber-500/20 text-amber-300 text-xs">
          Панель перенесена{status.newUrl ? <> на <span className="font-mono">{status.newUrl}</span></> : ''}.
        </div>
      )}

      {status.state === 'exporting' && (
        <div className="p-4 rounded-2xl border bg-amber-500/10 border-amber-500/20 text-amber-200 text-xs space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              Архив передан на новый сервер. Изменения в этой панели не сохраняются (иначе они потерялись бы) и фоновый опрос нод
              приостановлен. Перенос завершится сам, когда новая панель запустится; иначе блокировка снимется в {expires}.
            </span>
          </div>
          <button
            onClick={handleCancel}
            disabled={busy}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 font-medium text-xs px-4 py-2 rounded-xl transition"
          >
            <XCircle className="w-3.5 h-3.5 text-red-400" />
            <span>Отменить перенос</span>
          </button>
        </div>
      )}

      {status.state === 'idle' && !asking && (
        <div className="space-y-3">
          <ol className="text-xs text-zinc-400 space-y-1 list-decimal list-inside">
            <li>Нажмите «Подготовить перенос» — панель покажет код (действует час).</li>
            <li>На новом сервере запустите установщик и выберите «Перенос панели», введите адрес этой панели и код.</li>
            <li>В терминале выберите способ получения сертификата для нового сервера (новый домен, IP или готовые файлы).</li>
            <li>Когда новая панель запустится, эта будет заморожена; ссылки подписок перенаправятся на новый адрес.</li>
          </ol>
          <button
            onClick={() => setAsking(true)}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white font-medium text-xs px-5 py-2.5 rounded-xl transition shadow-lg shadow-purple-600/20"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>Подготовить перенос</span>
          </button>
        </div>
      )}

      {(asking || (status.state === 'prepared' && !issued)) && status.state !== 'exporting' && (
        <form onSubmit={handlePrepare} className="space-y-3">
          {status.state === 'prepared' && !issued && (
            <p className="text-xs text-zinc-400">
              Код переноса уже выдан и действует до {expires}, но показывается только один раз. Выдайте новый — прежний перестанет действовать.
            </p>
          )}
          <label className="block text-xs font-medium text-zinc-400">Пароль администратора для подтверждения</label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !password}
              className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium text-xs px-5 py-2.5 rounded-xl transition"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
              <span>Выдать код переноса</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setPassword('');
              }}
              className="text-xs text-zinc-400 hover:text-white px-2 py-2"
            >
              Отмена
            </button>
            {status.state === 'prepared' && (
              <button type="button" onClick={handleCancel} disabled={busy} className="text-xs text-red-400 hover:text-red-300 px-2 py-2">
                Отменить перенос
              </button>
            )}
          </div>
        </form>
      )}

      {status.state === 'prepared' && issued && (
        <div className="space-y-4">
          <div className="p-3 rounded-xl border bg-amber-500/10 border-amber-500/20 text-amber-300 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Код показан один раз и действует до {new Date(issued.expiresAt).toLocaleString()}. Он расшифровывает данные переноса — не публикуйте его.</span>
          </div>

          <CopyRow label="Код переноса" value={issued.code} secret />
          <CopyRow label="Адрес этой панели (укажите его на новом сервере)" value={panelAddress} />
          <CopyRow label="Команда для нового сервера (выберите «2) Перенос панели»)" value={INSTALL_COMMAND} />

          <div className="p-3 rounded-xl bg-zinc-950/60 border border-zinc-800 text-[11px] text-zinc-400 space-y-1">
            <p>
              <b className="text-zinc-300">Если новый сервер не достучится до этой панели</b> — скачайте архив файлом, скопируйте на новый сервер
              (например, scp) и в установщике укажите путь к файлу вместо адреса.
            </p>
            <p>
              <b className="text-zinc-300">Адрес и ссылки подписок.</b> Они содержат домен и порт панели. Если домен останется прежним — переключите его
              запись A на IP нового сервера, ссылки продолжат работать. Если домен новый — пока этот сервер включён, его ссылки подписок перенаправляются на новый адрес.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleDownload}
              disabled={busy}
              className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 font-medium text-xs px-4 py-2 rounded-xl transition"
            >
              <Download className="w-3.5 h-3.5 text-purple-400" />
              <span>Скачать архив файлом</span>
            </button>
            <button
              onClick={handleCancel}
              disabled={busy}
              className="flex items-center gap-2 text-xs text-red-400 hover:text-red-300 px-2 py-2"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Отменить перенос</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
