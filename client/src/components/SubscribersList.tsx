import React, { useState } from 'react';
import {
  Link2,
  Trash2,
  Power,
  Search,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  Server as ServerIcon,
  Users,
  Settings,
  RotateCcw,
} from 'lucide-react';
import type { Subscriber } from '../types';
import { api } from '../api';
import { formatBytes } from '../utils';

interface SubscribersListProps {
  subscribers: Subscriber[];
  onAddSubscriber: () => void;
  onEditSubscriber: (sub: Subscriber) => void;
  onShowSubscription: (sub: Subscriber) => void;
  onSubscriberUpdated: (sub: Subscriber) => void;
  onSubscriberDeleted: (id: number) => void;
}

export const SubscribersList: React.FC<SubscribersListProps> = ({
  subscribers,
  onAddSubscriber,
  onEditSubscriber,
  onShowSubscription,
  onSubscriberUpdated,
  onSubscriberDeleted,
}) => {
  const [search, setSearch] = useState('');

  const handleToggle = async (sub: Subscriber) => {
    try {
      const updated = await api.updateSubscriber(sub.id, {
        enabled: sub.enabled ? 0 : 1,
      });
      onSubscriberUpdated(updated);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleResetTraffic = async (sub: Subscriber) => {
    if (!confirm(`Обнулить счётчик трафика пользователя "${sub.name}"?`)) return;
    try {
      onSubscriberUpdated(await api.resetSubscriberTraffic(sub.id));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (sub: Subscriber) => {
    if (!confirm(`Удалить пользователя "${sub.name}" и все его конфигурации на серверах?`)) return;
    try {
      await api.deleteSubscriber(sub.id);
      onSubscriberDeleted(sub.id);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const filteredSubscribers = subscribers.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-6 shadow-xl space-y-5">
      {/* Table Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <span>Пользователи и подписки (Incy)</span>
            <span className="text-xs font-mono text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full">
              {subscribers.length}
            </span>
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Управление доступом к нодам и единые автообновляемые ссылки подписок
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Поиск по имени..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500 w-48 sm:w-60 transition"
            />
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2" />
          </div>

          <button
            onClick={onAddSubscriber}
            className="flex items-center gap-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-medium text-xs px-3.5 py-1.5 rounded-xl transition shadow-md shadow-emerald-600/20 active:scale-[0.98]"
          >
            <Plus className="w-4 h-4" />
            <span>Новый пользователь</span>
          </button>
        </div>
      </div>

      {/* Subscribers Table */}
      {filteredSubscribers.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-zinc-800 rounded-xl">
          <Users className="w-10 h-10 text-zinc-600 mx-auto mb-2" />
          <p className="text-sm font-medium text-zinc-400">Нет созданных пользователей</p>
          <p className="text-xs text-zinc-600 mt-1">
            Нажмите «Новый пользователь», чтобы настроить доступ к серверам и создать ссылку подписки
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="pb-3 font-medium">Пользователь</th>
                <th className="pb-3 font-medium">Доступные ноды (серверы)</th>
                <th className="pb-3 font-medium">Статус</th>
                <th className="pb-3 font-medium">Суммарный трафик</th>
                <th className="pb-3 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {filteredSubscribers.map((sub) => {
                const disabled = !sub.enabled;

                return (
                  <tr key={sub.id} className="hover:bg-zinc-800/20 transition">
                    {/* Name */}
                    <td className="py-3 font-medium text-white flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                      <span>{sub.name}</span>
                    </td>

                    {/* Servers Badges */}
                    <td className="py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {sub.servers && sub.servers.length > 0 ? (
                          sub.servers.map((s) => (
                            <span
                              key={s.id}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-zinc-950 border border-zinc-800 text-zinc-300"
                            >
                              <ServerIcon className="w-3 h-3 text-emerald-400" />
                              <span>{s.name}</span>
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-zinc-600 italic">Нет доступа к нодам</span>
                        )}
                      </div>
                    </td>

                    {/* Status Badge */}
                    <td className="py-3">
                      {disabled ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
                          Отключен
                        </span>
                      ) : sub.suspended ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          {sub.expired ? 'Срок истёк' : 'Лимит исчерпан'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          Активен
                        </span>
                      )}
                    </td>

                    {/* Traffic */}
                    <td className="py-3 text-zinc-300 font-mono">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1 text-emerald-400" title="Получено пользователем">
                          <ArrowDownRight className="w-3.5 h-3.5" />
                          {formatBytes(sub.total_tx)}
                        </span>
                        <span className="flex items-center gap-1 text-cyan-400" title="Отправлено пользователем">
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          {formatBytes(sub.total_rx)}
                        </span>
                      </div>
                      {(sub.traffic_limit > 0 || sub.expire_at) && (
                        <div className="text-[10px] text-zinc-500 mt-1 space-x-2">
                          {sub.traffic_limit > 0 && (
                            <span>{formatBytes(sub.traffic_used)} из {formatBytes(sub.traffic_limit)}</span>
                          )}
                          {sub.expire_at && <span>до {new Date(sub.expire_at).toLocaleDateString()}</span>}
                        </div>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Subscription Link & QR Modal */}
                        <button
                          onClick={() => onShowSubscription(sub)}
                          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded-lg transition font-medium"
                          title="Ссылка подписки и QR-код для Incy"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                          <span>Подписка</span>
                        </button>

                        {/* Edit Node Access */}
                        <button
                          onClick={() => onEditSubscriber(sub)}
                          title="Настроить доступ к серверам"
                          className="p-1.5 text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 rounded-lg transition"
                        >
                          <Settings className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleResetTraffic(sub)}
                          title="Обнулить трафик"
                          className="p-1.5 text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-lg transition"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>

                        {/* Toggle */}
                        <button
                          onClick={() => handleToggle(sub)}
                          title={sub.enabled ? 'Отключить пользователя' : 'Включить пользователя'}
                          className={`p-1.5 rounded-lg transition ${
                            sub.enabled
                              ? 'text-zinc-400 hover:text-amber-400 hover:bg-zinc-800'
                              : 'text-amber-400 hover:text-emerald-400 hover:bg-zinc-800'
                          }`}
                        >
                          <Power className="w-4 h-4" />
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => handleDelete(sub)}
                          title="Удалить пользователя"
                          className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
