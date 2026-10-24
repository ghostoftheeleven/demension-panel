import React, { useState } from 'react';
import {
  QrCode,
  Download,
  Trash2,
  Power,
  Search,
  Plus,
  ArrowDownRight,
  ArrowUpRight,
  Clock,
  Laptop,
} from 'lucide-react';
import type { Client } from '../types';
import { api } from '../api';
import { formatBytes } from '../utils';

interface ClientListProps {
  clients: Client[];
  serverName: string;
  serverOnline?: boolean;
  onAddClient: () => void;
  onShowQr: (clientId: number) => void;
  onClientUpdated: (client: Client) => void;
  onClientDeleted: (clientId: number) => void;
}

export const ClientList: React.FC<ClientListProps> = ({
  clients,
  serverName,
  onAddClient,
  onShowQr,
  onClientUpdated,
  onClientDeleted,
}) => {
  const [search, setSearch] = useState('');

  const formatLastHandshake = (dateStr: string | null) => {
    if (!dateStr) return 'Никогда';
    const date = new Date(dateStr);
    const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);

    if (diffSec < 60) return `${diffSec} сек назад`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} мин назад`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ч назад`;
    return date.toLocaleDateString();
  };

  const isOnline = (dateStr: string | null) => {
    if (!dateStr) return false;
    const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    return diffSec < 180; // active within last 3 minutes
  };

  const handleToggle = async (client: Client) => {
    try {
      const updated = await api.updateClient(client.id, {
        enabled: client.enabled ? 0 : 1,
      });
      onClientUpdated(updated);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDownload = async (client: Client) => {
    try {
      await api.downloadClientConfig(client.id, client.name);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (client: Client) => {
    if (!confirm(`Удалить клиента "${client.name}"?`)) return;
    try {
      await api.deleteClient(client.id);
      onClientDeleted(client.id);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const filteredClients = clients.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.client_ip.includes(search)
  );

  return (
    <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-6 shadow-xl space-y-5">
      {/* Table Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            <span>Клиенты AmneziaWG</span>
            <span className="text-xs font-mono text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full">
              {clients.length}
            </span>
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">Управление пирами и устройствами сервера {serverName}</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Поиск по имени или IP..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500 w-48 sm:w-60 transition"
            />
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-2" />
          </div>

          <button
            onClick={onAddClient}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-3.5 py-1.5 rounded-xl transition shadow-md shadow-emerald-600/20 active:scale-[0.98]"
          >
            <Plus className="w-4 h-4" />
            <span>Добавить клиента</span>
          </button>
        </div>
      </div>

      {/* Clients Table */}
      {filteredClients.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-zinc-800 rounded-xl">
          <Laptop className="w-10 h-10 text-zinc-600 mx-auto mb-2" />
          <p className="text-sm font-medium text-zinc-400">Нет добавленных клиентов</p>
          <p className="text-xs text-zinc-600 mt-1">
            Нажмите «Добавить клиента», чтобы сгенерировать конфигурацию и QR-код
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="pb-3 font-medium">Клиент / Устройство</th>
                <th className="pb-3 font-medium">IP адрес</th>
                <th className="pb-3 font-medium">Статус</th>
                <th className="pb-3 font-medium">Трафик (получено / отправлено)</th>
                <th className="pb-3 font-medium">Активность</th>
                <th className="pb-3 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {filteredClients.map((client) => {
                const online = isOnline(client.last_handshake);
                const disabled = !client.enabled;

                return (
                  <tr key={client.id} className="hover:bg-zinc-800/20 transition">
                    {/* Name */}
                    <td className="py-3 font-medium text-white flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${disabled ? 'bg-zinc-600' : online ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
                      <span>{client.name}</span>
                    </td>

                    {/* IP */}
                    <td className="py-3 font-mono text-zinc-300">
                      {client.client_ip}
                    </td>

                    {/* Status Badge */}
                    <td className="py-3">
                      {disabled ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
                          Отключен
                        </span>
                      ) : online ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          Онлайн
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-zinc-800/60 text-zinc-400 border border-zinc-700/50">
                          Неактивен
                        </span>
                      )}
                    </td>

                    {/* Traffic */}
                    <td className="py-3 text-zinc-300 font-mono">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1 text-emerald-400" title="Получено клиентом">
                          <ArrowDownRight className="w-3.5 h-3.5" />
                          {formatBytes(client.total_tx)}
                        </span>
                        <span className="flex items-center gap-1 text-cyan-400" title="Отправлено клиентом">
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          {formatBytes(client.total_rx)}
                        </span>
                      </div>
                    </td>

                    {/* Last Handshake */}
                    <td className="py-3 text-zinc-400">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-zinc-500" />
                        <span>{formatLastHandshake(client.last_handshake)}</span>
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => onShowQr(client.id)}
                          title="Показать QR-код"
                          className="p-1.5 text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800 rounded-lg transition"
                        >
                          <QrCode className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleDownload(client)}
                          title="Скачать .conf"
                          className="p-1.5 text-zinc-400 hover:text-cyan-400 hover:bg-zinc-800 rounded-lg transition"
                        >
                          <Download className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleToggle(client)}
                          title={client.enabled ? 'Отключить пира' : 'Включить пира'}
                          className={`p-1.5 rounded-lg transition ${
                            client.enabled
                              ? 'text-zinc-400 hover:text-amber-400 hover:bg-zinc-800'
                              : 'text-amber-400 hover:text-emerald-400 hover:bg-zinc-800'
                          }`}
                        >
                          <Power className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleDelete(client)}
                          title="Удалить пира"
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
