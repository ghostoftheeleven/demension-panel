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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/60 animate-in fade-in duration-200">
      <div className="bg-card border-2 border-ink rounded-2xl w-full max-w-md shadow-brutal overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-ink bg-card">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-ok" />
            <div>
              <h2 className="text-base font-semibold text-ink">Новый клиент AmneziaWG</h2>
              <p className="text-xs text-muted">{serverName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink transition p-1 rounded-lg hover:bg-soft border-2 border-ink"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-bad-soft border-2 border-ink rounded-xl text-bad text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1">
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
                className="w-full bg-paper border-2 border-ink rounded-xl pl-9 pr-3.5 py-2 text-ink placeholder-faint focus:outline-none focus:border-ink transition text-sm"
              />
              <Smartphone className="w-4 h-4 text-faint absolute left-3 top-2.5" />
            </div>
            <p className="text-[11px] text-faint mt-2">
              Ключи Curve25519 и свободный IP-адрес из подсети сервера будут назначены автоматически.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted hover:text-ink transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="bg-mint hover:bg-mint disabled:opacity-50 text-ink font-bold text-sm px-5 py-2 rounded-xl transition shadow-brutal-sm border-2 border-ink btn-press"
            >
              {loading ? 'Создание...' : 'Создать клиента'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
