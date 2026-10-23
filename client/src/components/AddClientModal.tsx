import React, { useState } from 'react';
import { X, UserPlus, Smartphone } from 'lucide-react';
import { api } from '../api';
import type { Client } from '../types';

interface AddClientModalProps {
  isOpen: boolean;
  serverId: number | null;
  serverName: string;
  onClose: () => void;
  onClientAdded: (client: Client) => void;
}

export const AddClientModal: React.FC<AddClientModalProps> = ({
  isOpen,
  serverId,
  serverName,
  onClose,
  onClientAdded,
}) => {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !serverId) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setError(null);
    setLoading(true);

    try {
      const client = await api.createClient(serverId, name.trim());
      onClientAdded(client);
      setName('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Ошибка создания клиента');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-base font-semibold text-white">Новый клиент AmneziaWG</h2>
              <p className="text-xs text-zinc-400">{serverName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition p-1 rounded-lg hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">
              Имя клиента / Устройства
            </label>
            <div className="relative">
              <input
                type="text"
                required
                autoFocus
                placeholder="например: iPhone-Alex, Home-PC"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl pl-9 pr-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm"
              />
              <Smartphone className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5" />
            </div>
            <p className="text-[11px] text-zinc-500 mt-2">
              Ключи Curve25519 и свободный IP-адрес из подсети сервера будут назначены автоматически.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm px-5 py-2 rounded-xl transition shadow-lg shadow-emerald-600/20"
            >
              {loading ? 'Создание...' : 'Создать клиента'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
