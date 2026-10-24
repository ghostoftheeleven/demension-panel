import React, { useState } from 'react';
import { Loader2, Download, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { api } from '../api';
import type { AmneziaImportResult } from '../types';

const STATUS_VIEW: Record<AmneziaImportResult['status'], { label: string; className: string; icon: React.ReactNode }> = {
  adopted: { label: 'Подключён без переустановки', className: 'text-emerald-300', icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" /> },
  needs_install: { label: 'Добавлен, требуется установка', className: 'text-amber-300', icon: <AlertTriangle className="w-4 h-4 text-amber-400" /> },
  ssh_error: { label: 'Добавлен, нет SSH-доступа', className: 'text-amber-300', icon: <AlertTriangle className="w-4 h-4 text-amber-400" /> },
  exists: { label: 'Уже есть в панели', className: 'text-zinc-400', icon: <AlertTriangle className="w-4 h-4 text-zinc-500" /> },
  invalid: { label: 'Ключ не подходит', className: 'text-red-300', icon: <XCircle className="w-4 h-4 text-red-400" /> },
};

/**
 * Перенос серверов из AmneziaVPN по ключам «Поделиться → Полный доступ» (vpn://…)
 */
export const AmneziaImportPanel: React.FC<{ onImported: () => void; onClose: () => void }> = ({ onImported, onClose }) => {
  const [keys, setKeys] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AmneziaImportResult[] | null>(null);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.importAmneziaKeys(keys);
      setResults(res.results);
      setKeys('');
      onImported();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (results) {
    return (
      <div className="p-6 space-y-4 overflow-y-auto">
        <div className="space-y-2">
          {results.map((r, i) => {
            const view = STATUS_VIEW[r.status];
            return (
              <div key={i} className="p-3 bg-zinc-950/60 border border-zinc-800 rounded-xl text-xs space-y-1">
                <div className="flex items-center gap-2">
                  {view.icon}
                  <span className="font-medium text-white">{r.name || r.key}</span>
                  <span className={view.className}>{view.label}</span>
                </div>
                <p className="text-zinc-400">{r.message}</p>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-zinc-500">
          Клиенты, созданные в AmneziaVPN, продолжают работать и видны в панели с пометкой «импорт», но их конфигурации панель выдать не может.
          Новых клиентов создавайте в панели. Не меняйте клиентов этих серверов в приложении AmneziaVPN — панель перезапишет конфигурацию.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setResults(null)} className="px-4 py-2 text-sm text-zinc-400 hover:text-white">
            Импортировать ещё
          </button>
          <button type="button" onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm">
            Готово
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleImport} className="p-6 space-y-4 overflow-y-auto">
      {error && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">{error}</div>}
      <div className="p-3 bg-zinc-950/60 border border-zinc-800 rounded-xl text-xs text-zinc-400 space-y-1">
        <p>
          В приложении AmneziaVPN откройте сервер → <strong className="text-zinc-200">«Поделиться»</strong> →{' '}
          <strong className="text-zinc-200">«Полный доступ»</strong> и скопируйте ключ <code>vpn://…</code>.
        </p>
        <p>
          Панель подключится к серверу по SSH из ключа и заберёт работающий AmneziaWG вместе с ключами, параметрами и клиентами — переустанавливать
          ничего не нужно. Можно вставить несколько ключей, по одному на строку.
        </p>
      </div>
      <textarea
        required
        rows={6}
        value={keys}
        onChange={(e) => setKeys(e.target.value)}
        placeholder="vpn://AAAB..."
        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition font-mono text-xs"
      />
      <p className="text-[11px] text-amber-300/80">
        Ключ полного доступа содержит пароль или SSH-ключ сервера. В панели он хранится зашифрованным, сам ключ не сохраняется.
      </p>
      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition">
          Отмена
        </button>
        <button
          type="submit"
          disabled={loading}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm px-5 py-2 rounded-xl transition"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          <span>{loading ? 'Подключение к серверам...' : 'Импортировать'}</span>
        </button>
      </div>
    </form>
  );
};
