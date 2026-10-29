import React, { useCallback, useEffect, useState } from 'react';
import { Ban } from 'lucide-react';
import type { Partner, PartnerAuditEntry, PartnerClient } from '../../types';
import { api } from '../../api';
import { formatBytes } from '../../utils';
import { useFeedback } from '../ui/feedback-context';
import { iconButton, AUDIT_LABELS, formatDate } from './shared';

export const PartnerDetails: React.FC<{ partner: Partner }> = ({ partner }) => {
  const { toast } = useFeedback();
  const [clients, setClients] = useState<PartnerClient[] | null>(null);
  const [audit, setAudit] = useState<PartnerAuditEntry[]>([]);

  const load = useCallback(() => {
    Promise.all([api.getPartnerClients(partner.id), api.getPartnerAudit(partner.id)])
      .then(([c, a]) => {
        setClients(c);
        setAudit(a);
      })
      .catch((err) => toast(err.message, 'error'));
  }, [partner.id, toast]);

  useEffect(load, [load]);

  const toggleBlock = async (client: PartnerClient) => {
    try {
      await api.updateClient(client.id, { enabled: client.owner_blocked ? 1 : 0 });
      load();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  if (!clients) return <p className="text-xs text-faint py-3">Загрузка...</p>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-3">
      <div className="lg:col-span-2">
        <h4 className="text-xs font-semibold text-ink mb-2">Клиенты партнёра ({clients.length})</h4>
        {clients.length === 0 ? (
          <p className="text-xs text-faint">Партнёр ещё не создал клиентов.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-faint border-b border-line">
                  <th className="pb-2 font-medium">Клиент</th>
                  <th className="pb-2 font-medium">Нода</th>
                  <th className="pb-2 font-medium">IP</th>
                  <th className="pb-2 font-medium">Трафик</th>
                  <th className="pb-2 font-medium">Подключение</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 text-ink">
                      {c.name}
                      {c.owner_blocked && <span className="ml-1.5 text-xs text-bad">заблокирован</span>}
                      {!c.enabled && !c.owner_blocked && <span className="ml-1.5 text-xs text-faint">выключен партнёром</span>}
                    </td>
                    <td className="py-2 text-muted">{c.server_name}</td>
                    <td className="py-2 font-mono text-muted">{c.client_ip}</td>
                    <td className="py-2 font-mono text-muted">{formatBytes(c.total_rx + c.total_tx)}</td>
                    <td className="py-2 text-faint">{formatDate(c.last_handshake)}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => toggleBlock(c)}
                        title={c.owner_blocked ? 'Разблокировать' : 'Заблокировать'}
                        className={`${iconButton} ${c.owner_blocked ? 'text-bad hover:text-ok' : 'hover:text-bad'}`}
                      >
                        <Ban className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <h4 className="text-xs font-semibold text-ink mb-2">Журнал действий</h4>
        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {audit.length === 0 && <p className="text-xs text-faint">Пусто</p>}
          {audit.map((entry) => (
            <div key={entry.id} className="text-xs">
              <span className="text-ink">{AUDIT_LABELS[entry.action] || entry.action}</span>
              {entry.details && <span className="text-faint"> · {entry.details}</span>}
              <div className="text-faint">
                {formatDate(entry.created_at)}
                {entry.ip ? ` · ${entry.ip}` : ''}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
