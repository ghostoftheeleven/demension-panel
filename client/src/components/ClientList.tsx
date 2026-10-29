import React, { useEffect, useState } from 'react';
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const formatLastHandshake = (dateStr: string | null) => {
    if (!dateStr) return 'Никогда';
    const date = new Date(dateStr);
    const diffSec = Math.max(0, Math.floor((now - date.getTime()) / 1000));

    if (diffSec < 60) return `${diffSec} сек назад`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} мин назад`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ч назад`;
    return date.toLocaleDateString();
  };

  const isOnline = (dateStr: string | null) => {
    if (!dateStr) return false;
    const diffSec = Math.floor((now - new Date(dateStr).getTime()) / 1000);
    return diffSec < 180; // active within last 3 minutes
  };

  const handleToggle = async (client: Client) => {
    try {
      // Для клиента партнёра переключатель блокирует/разблокирует его владельцем
      const active = client.partner_name ? !client.owner_blocked : Boolean(client.enabled);
      const updated = await api.updateClient(client.id, {
        enabled: active ? 0 : 1,
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
    <div className="bg-card border border-line rounded-2xl p-6 shadow-pop space-y-5">
      {/* Table Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-ink flex items-center gap-2">
            <span>Клиенты AmneziaWG</span>
            <span className="text-xs font-mono text-muted bg-soft px-2 py-0.5 rounded-full border border-line">
              {clients.length}
            </span>
          </h3>
          <p className="text-xs text-muted mt-0.5">Управление пирами и устройствами сервера {serverName}</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative" data-guest-ok>
            <input
              type="text"
              placeholder="Поиск по имени или IP..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-paper border border-line rounded-xl pl-8 pr-3 py-1.5 text-xs text-ink placeholder-faint focus:outline-none focus:border-mint w-48 sm:w-60 transition"
            />
            <Search className="w-3.5 h-3.5 text-faint absolute left-2.5 top-2" />
          </div>

          <button
            onClick={onAddClient}
            className="flex items-center gap-1.5 bg-mint hover:bg-mint text-on-accent font-bold text-xs px-3.5 py-1.5 rounded-full transition btn-press hover:text-on-accent"
          >
            <Plus className="w-4 h-4" />
            <span>Добавить клиента</span>
          </button>
        </div>
      </div>

      {/* Clients Table */}
      {filteredClients.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-line rounded-xl">
          <Laptop className="w-10 h-10 text-faint mx-auto mb-2" />
          <p className="text-sm font-medium text-muted">Нет добавленных клиентов</p>
          <p className="text-xs text-faint mt-1">
            Нажмите «Добавить клиента», чтобы сгенерировать конфигурацию и QR-код
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-muted">
                <th className="pb-3 font-medium">Клиент / Устройство</th>
                <th className="pb-3 font-medium">IP адрес</th>
                <th className="pb-3 font-medium">Статус</th>
                <th className="pb-3 font-medium">Трафик (получено / отправлено)</th>
                <th className="pb-3 font-medium">Активность</th>
                <th className="pb-3 font-medium text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredClients.map((client) => {
                const online = isOnline(client.last_handshake);
                const disabled = !client.enabled || client.owner_blocked;
                const keyless = client.external || Boolean(client.partner_name) || client.pending;

                return (
                  <tr key={client.id} className="hover:bg-soft transition">
                    {/* Name */}
                    <td className="py-3 font-medium text-ink flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${disabled ? 'bg-faint' : online ? 'bg-mint' : 'bg-faint'}`} />
                      <span>{client.name}</span>
                      {client.partner_name && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-warn-soft text-warn border border-line"
                          title="Клиент создан панелью партнёра. Его можно заблокировать, но не удалить."
                        >
                          партнёр: {client.partner_name}
                        </span>
                      )}
                      {client.pending && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-soft text-muted border border-line"
                          title={client.remote_state?.startsWith('error') ? client.remote_state.slice(7) : 'Ожидает создания на ноде партнёра'}
                        >
                          {client.remote_state?.startsWith('error') ? 'ошибка у владельца' : 'создаётся'}
                        </span>
                      )}
                      {client.remote_state === 'blocked' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-bad-soft text-bad border border-line">
                          заблокирован владельцем
                        </span>
                      )}
                      {client.external && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-soft text-muted border border-line"
                          title="Импортирован из существующей установки: конфигурация и QR-код недоступны"
                        >
                          импорт
                        </span>
                      )}
                    </td>

                    {/* IP */}
                    <td className="py-3 font-mono text-ink">
                      {client.client_ip}
                    </td>

                    {/* Status Badge */}
                    <td className="py-3">
                      {disabled ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-soft text-muted border border-line">
                          Отключен
                        </span>
                      ) : online ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-ok-soft text-ok border border-line">
                          <span className="w-1.5 h-1.5 rounded-full bg-mint animate-pulse" />
                          Онлайн
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-soft text-muted border border-line">
                          Неактивен
                        </span>
                      )}
                    </td>

                    {/* Traffic */}
                    <td className="py-3 text-ink font-mono">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1 text-ok" title="Получено клиентом">
                          <ArrowDownRight className="w-3.5 h-3.5" />
                          {formatBytes(client.total_tx)}
                        </span>
                        <span className="flex items-center gap-1 text-info" title="Отправлено клиентом">
                          <ArrowUpRight className="w-3.5 h-3.5" />
                          {formatBytes(client.total_rx)}
                        </span>
                      </div>
                    </td>

                    {/* Last Handshake */}
                    <td className="py-3 text-muted">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-faint" />
                        <span>{formatLastHandshake(client.last_handshake)}</span>
                      </div>
                    </td>

                    {/* Actions */}
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => onShowQr(client.id)}
                          disabled={keyless}
                          title={keyless ? 'Конфигурация недоступна для этого клиента' : 'Показать QR-код'}
                          className="p-1.5 text-muted hover:text-ok hover:bg-soft rounded-lg transition border border-line"
                        >
                          <QrCode className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleDownload(client)}
                          disabled={keyless}
                          title={keyless ? 'Конфигурация недоступна для этого клиента' : 'Скачать .conf'}
                          className="p-1.5 text-muted hover:text-info hover:bg-soft rounded-lg transition border border-line"
                        >
                          <Download className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleToggle(client)}
                          title={!disabled ? (client.partner_name ? 'Заблокировать клиента партнёра' : 'Отключить пира') : (client.partner_name ? 'Разблокировать' : 'Включить пира')}
                          className={`p-1.5 rounded-lg transition ${
                            !disabled
                              ? 'text-muted hover:text-warn hover:bg-soft'
                              : 'text-warn hover:text-ok hover:bg-soft'
                          }`}
                        >
                          <Power className="w-4 h-4" />
                        </button>

                        {!client.partner_name && (
                        <button
                          onClick={() => handleDelete(client)}
                          title="Удалить пира"
                          className="p-1.5 text-muted hover:text-bad hover:bg-soft rounded-lg transition border border-line"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        )}
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
