import React, { useState, useEffect } from 'react';
import { X, UserPlus, Server as ServerIcon, CheckSquare, Square, Shield } from 'lucide-react';
import type { Server, Subscriber } from '../types';
import { api } from '../api';

interface AddSubscriberModalProps {
  isOpen: boolean;
  servers: Server[];
  editingSubscriber: Subscriber | null;
  onClose: () => void;
  onSaved: (subscriber: Subscriber) => void;
}

export const AddSubscriberModal: React.FC<AddSubscriberModalProps> = ({
  isOpen,
  servers,
  editingSubscriber,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [selectedServerIds, setSelectedServerIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editingSubscriber) {
      setName(editingSubscriber.name);
      setSelectedServerIds(editingSubscriber.server_ids || []);
    } else {
      setName('');
      // By default select all online servers
      setSelectedServerIds(servers.filter((s) => s.status === 'online').map((s) => s.id));
    }
  }, [editingSubscriber, servers, isOpen]);

  if (!isOpen) return null;

  const toggleServer = (serverId: number) => {
    setSelectedServerIds((prev) =>
      prev.includes(serverId) ? prev.filter((id) => id !== serverId) : [...prev, serverId]
    );
  };

  const selectAll = () => {
    setSelectedServerIds(servers.map((s) => s.id));
  };

  const deselectAll = () => {
    setSelectedServerIds([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setError(null);
    setLoading(true);

    try {
      if (editingSubscriber) {
        const updated = await api.updateSubscriber(editingSubscriber.id, {
          name: name.trim(),
          server_ids: selectedServerIds,
        });
        onSaved({ ...editingSubscriber, ...updated, server_ids: selectedServerIds });
      } else {
        const created = await api.createSubscriber({
          name: name.trim(),
          server_ids: selectedServerIds,
        });
        onSaved(created);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Ошибка сохранения пользователя');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <UserPlus className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-base font-semibold text-white">
                {editingSubscriber ? 'Редактировать доступ к нодам' : 'Новый пользователь (Подписка)'}
              </h2>
              <p className="text-xs text-zinc-400">
                {editingSubscriber ? editingSubscriber.name : 'Генерация мультисерверной подписки для HAPP и Incy'}
              </p>
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
        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
              Имя пользователя / Клиента
            </label>
            <input
              type="text"
              required
              autoFocus
              placeholder="например: Иван, Alex-iOS, Client-01"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm"
            />
          </div>

          {/* Node Selection Checkboxes */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                <ServerIcon className="w-3.5 h-3.5 text-emerald-400" />
                <span>Доступные ноды (серверы):</span>
              </label>

              <div className="flex items-center gap-2 text-[11px]">
                <button
                  type="button"
                  onClick={selectAll}
                  className="text-emerald-400 hover:text-emerald-300 transition"
                >
                  Выбрать все
                </button>
                <span className="text-zinc-600">&bull;</span>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="text-zinc-500 hover:text-zinc-400 transition"
                >
                  Снять все
                </button>
              </div>
            </div>

            {servers.length === 0 ? (
              <div className="p-4 bg-zinc-950/60 border border-dashed border-zinc-800 rounded-2xl text-center text-xs text-zinc-500">
                Нет добавленных серверов. Сначала добавьте хотя бы один сервер AmneziaWG.
              </div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {servers.map((s) => {
                  const isChecked = selectedServerIds.includes(s.id);
                  const isOnline = s.status === 'online';

                  return (
                    <div
                      key={s.id}
                      onClick={() => toggleServer(s.id)}
                      className={`flex items-center justify-between p-3 rounded-2xl border cursor-pointer transition select-none ${
                        isChecked
                          ? 'bg-zinc-800/80 border-emerald-500/40 text-white'
                          : 'bg-zinc-950/50 border-zinc-800/80 text-zinc-400 hover:bg-zinc-900/60'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {isChecked ? (
                          <CheckSquare className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                        ) : (
                          <Square className="w-4 h-4 text-zinc-600 flex-shrink-0" />
                        )}
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">{s.name}</span>
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                isOnline ? 'bg-emerald-400' : 'bg-zinc-600'
                              }`}
                            />
                          </div>
                          <p className="text-[11px] font-mono text-zinc-500">{s.host}:{s.awg_port}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                        <Shield className="w-3 h-3 text-emerald-400" />
                        <span>AWG</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-zinc-500 mt-2">
              * Пользователь получит единую ссылку подписки. Все выбранные ноды появятся у него в HAPP / Incy автоматически.
            </p>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
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
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm px-5 py-2.5 rounded-xl transition shadow-lg shadow-emerald-600/20"
            >
              {loading ? 'Сохранение...' : editingSubscriber ? 'Обновить доступ' : 'Создать подписку'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
