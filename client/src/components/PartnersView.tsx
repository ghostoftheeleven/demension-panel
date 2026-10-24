import React, { useCallback, useEffect, useState } from 'react';
import {
  Handshake,
  Plus,
  Copy,
  KeyRound,
  Trash2,
  Pencil,
  Power,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Link2,
  Unplug,
  X,
  Loader2,
  Ban,
} from 'lucide-react';
import type { Partner, PartnerAuditEntry, PartnerClient, RemotePanel, Server } from '../types';
import { api } from '../api';
import { copyToClipboard, formatBytes, GIB } from '../utils';

const cardClass = 'bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-6 shadow-xl space-y-4';
const inputClass =
  'w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm';
const iconButton = 'p-1.5 text-zinc-400 hover:bg-zinc-800 rounded-lg transition';

const AUDIT_LABELS: Record<string, string> = {
  created: 'Доступ создан',
  updated: 'Доступ изменён',
  token_regenerated: 'Токен перевыпущен',
  suspended: 'Доступ приостановлен',
  resumed: 'Доступ возобновлён',
  peer_created: 'Партнёр создал клиента',
  peer_deleted: 'Партнёр удалил клиента',
  peer_enabled: 'Партнёр включил клиента',
  peer_disabled: 'Партнёр выключил клиента',
  owner_blocked: 'Вы заблокировали клиента',
  owner_unblocked: 'Вы разблокировали клиента',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function toDateInput(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : '';
}

// ==============================================================================
// Окно создания/редактирования доступа
// ==============================================================================

const PartnerModal: React.FC<{
  partner: Partner | null;
  servers: Server[];
  onClose: () => void;
  onSaved: (result: { partner: Partner; connectString?: string }) => void;
}> = ({ partner, servers, onClose, onSaved }) => {
  const ownServers = servers.filter((s) => !s.remote_panel_id);
  const [name, setName] = useState(partner?.name ?? '');
  const [nodeIds, setNodeIds] = useState<number[]>(partner?.node_ids ?? []);
  const [maxClients, setMaxClients] = useState(partner?.max_clients ? String(partner.max_clients) : '');
  const [limitGb, setLimitGb] = useState(partner?.traffic_limit ? String(+(partner.traffic_limit / GIB).toFixed(2)) : '');
  const [expireDate, setExpireDate] = useState(toDateInput(partner?.expire_at ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleNode = (id: number) => setNodeIds((prev) => (prev.includes(id) ? prev.filter((n) => n !== id) : [...prev, id]));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const data = {
      name: name.trim(),
      node_ids: nodeIds,
      max_clients: maxClients.trim() ? parseInt(maxClients, 10) : 0,
      traffic_limit: limitGb.trim() ? Math.round(parseFloat(limitGb.replace(',', '.')) * GIB) : 0,
      expire_at: expireDate ? new Date(`${expireDate}T23:59:59`).toISOString() : null,
    };
    try {
      if (partner) {
        onSaved({ partner: await api.updatePartner(partner.id, data) });
      } else {
        const created = await api.createPartner(data);
        onSaved({ partner: created.partner, connectString: created.connect_string });
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-white">{partner ? 'Изменить доступ партнёра' : 'Выдать доступ к нодам'}</h2>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          {error && <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs">{error}</div>}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Партнёр</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="например: Панель Пети" className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Доступные ноды</label>
            {ownServers.length === 0 ? (
              <p className="text-xs text-zinc-500">Нет своих нод.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {ownServers.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-xs text-zinc-200 bg-zinc-950/60 border border-zinc-800 rounded-xl px-3 py-2 cursor-pointer">
                    <input type="checkbox" checked={nodeIds.includes(s.id)} onChange={() => toggleNode(s.id)} />
                    <span className="font-medium">{s.name}</span>
                    <span className="font-mono text-zinc-500">{s.host}</span>
                    {s.status === 'uninstalled' && <span className="text-amber-400/80">не установлена</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Макс. клиентов</label>
              <input type="number" min={0} value={maxClients} onChange={(e) => setMaxClients(e.target.value)} placeholder="без лимита" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Трафик, ГБ</label>
              <input type="number" min={0} step="0.1" value={limitGb} onChange={(e) => setLimitGb(e.target.value)} placeholder="без лимита" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Действует до</label>
              <input type="date" value={expireDate} onChange={(e) => setExpireDate(e.target.value)} className={inputClass} />
            </div>
          </div>
          <p className="text-[11px] text-zinc-500">
            Партнёр сможет создавать клиентов на выбранных нодах из своей панели. Приватные ключи его клиентов к вам не попадают;
            вы видите клиентов, их трафик и можете блокировать их.
          </p>
        </div>
        <div className="px-6 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white">
            Отмена
          </button>
          <button type="submit" disabled={saving} className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-xl">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{partner ? 'Сохранить' : 'Создать доступ'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};

// ==============================================================================
// Окно с токеном (показывается один раз)
// ==============================================================================

const TokenModal: React.FC<{ connectString: string; onClose: () => void }> = ({ connectString, onClose }) => {
  const [copied, setCopied] = useState(false);
  const insecure = connectString.startsWith('http:');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-lg shadow-2xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-amber-400" />
          <span>Строка подключения для партнёра</span>
        </h2>
        <p className="text-xs text-zinc-400">
          Передайте её партнёру по защищённому каналу. Он вставит её в своей панели: «Партнёры» → «Подключить панель партнёра».
          <strong className="text-amber-300"> Токен показывается только один раз</strong> — при утере перевыпустите его.
        </p>
        <textarea readOnly value={connectString} rows={3} className={`${inputClass} font-mono text-xs select-all`} />
        {insecure && (
          <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl p-3">
            Панель открыта по HTTP: партнёр не сможет подключиться, пока вы не включите HTTPS (раздел «Безопасность») или не укажете
            публичный https-адрес в настройках панели.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={async () => {
              if (await copyToClipboard(connectString)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            }}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-xl"
          >
            <Copy className="w-4 h-4" />
            <span>{copied ? 'Скопировано' : 'Копировать'}</span>
          </button>
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-sm">
            Готово
          </button>
        </div>
      </div>
    </div>
  );
};

// ==============================================================================
// Детали доступа: клиенты партнёра и журнал
// ==============================================================================

const PartnerDetails: React.FC<{ partner: Partner }> = ({ partner }) => {
  const [clients, setClients] = useState<PartnerClient[] | null>(null);
  const [audit, setAudit] = useState<PartnerAuditEntry[]>([]);

  const load = useCallback(() => {
    Promise.all([api.getPartnerClients(partner.id), api.getPartnerAudit(partner.id)])
      .then(([c, a]) => {
        setClients(c);
        setAudit(a);
      })
      .catch((err) => alert(err.message));
  }, [partner.id]);

  useEffect(load, [load]);

  const toggleBlock = async (client: PartnerClient) => {
    try {
      await api.updateClient(client.id, { enabled: client.owner_blocked ? 1 : 0 });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (!clients) return <p className="text-xs text-zinc-500 py-3">Загрузка...</p>;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-3">
      <div className="lg:col-span-2">
        <h4 className="text-xs font-semibold text-zinc-300 mb-2">Клиенты партнёра ({clients.length})</h4>
        {clients.length === 0 ? (
          <p className="text-xs text-zinc-500">Партнёр ещё не создал клиентов.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-800">
                  <th className="pb-2 font-medium">Клиент</th>
                  <th className="pb-2 font-medium">Нода</th>
                  <th className="pb-2 font-medium">IP</th>
                  <th className="pb-2 font-medium">Трафик</th>
                  <th className="pb-2 font-medium">Подключение</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 text-zinc-200">
                      {c.name}
                      {c.owner_blocked && <span className="ml-1.5 text-[10px] text-red-300">заблокирован</span>}
                      {!c.enabled && !c.owner_blocked && <span className="ml-1.5 text-[10px] text-zinc-500">выключен партнёром</span>}
                    </td>
                    <td className="py-2 text-zinc-400">{c.server_name}</td>
                    <td className="py-2 font-mono text-zinc-400">{c.client_ip}</td>
                    <td className="py-2 font-mono text-zinc-400">{formatBytes(c.total_rx + c.total_tx)}</td>
                    <td className="py-2 text-zinc-500">{formatDate(c.last_handshake)}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => toggleBlock(c)}
                        title={c.owner_blocked ? 'Разблокировать' : 'Заблокировать'}
                        className={`${iconButton} ${c.owner_blocked ? 'text-red-400 hover:text-emerald-400' : 'hover:text-red-400'}`}
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
        <h4 className="text-xs font-semibold text-zinc-300 mb-2">Журнал действий</h4>
        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {audit.length === 0 && <p className="text-xs text-zinc-500">Пусто</p>}
          {audit.map((entry) => (
            <div key={entry.id} className="text-[11px]">
              <span className="text-zinc-300">{AUDIT_LABELS[entry.action] || entry.action}</span>
              {entry.details && <span className="text-zinc-500"> · {entry.details}</span>}
              <div className="text-zinc-600">
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

// ==============================================================================
// Страница
// ==============================================================================

export const PartnersView: React.FC<{ servers: Server[]; publicUrl: string | null; onChanged: () => void }> = ({
  servers,
  onChanged,
}) => {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [panels, setPanels] = useState<RemotePanel[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalPartner, setModalPartner] = useState<Partner | null | undefined>(undefined);
  const [connectString, setConnectString] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [connectInput, setConnectInput] = useState('');
  const [connectName, setConnectName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.getPartners(), api.getRemotePanels()]);
      setPartners(p);
      setPanels(r);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const serverName = (id: number) => servers.find((s) => s.id === id)?.name || `#${id}`;

  const togglePartner = async (partner: Partner) => {
    if (partner.enabled && !confirm(`Отключить доступ «${partner.name}»? Все его клиенты на ваших нодах перестанут работать.`)) return;
    try {
      await api.updatePartner(partner.id, { enabled: !partner.enabled });
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const regenerate = async (partner: Partner) => {
    if (!confirm(`Перевыпустить токен «${partner.name}»? Старый токен перестанет работать — партнёру нужно будет переподключить панель.`)) return;
    try {
      const res = await api.regeneratePartnerToken(partner.id);
      setConnectString(res.connect_string);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const removePartner = async (partner: Partner) => {
    if (!confirm(`Удалить доступ «${partner.name}»? Все клиенты партнёра будут удалены с ваших нод.`)) return;
    try {
      await api.deletePartner(partner.id);
      load();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    try {
      await api.connectRemotePanel(connectInput.trim(), connectName.trim() || undefined);
      setConnectInput('');
      setConnectName('');
      await load();
      onChanged();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setConnecting(false);
    }
  };

  const syncPanel = async (panel: RemotePanel) => {
    setSyncing(panel.id);
    try {
      await api.syncRemotePanel(panel.id);
      await load();
      onChanged();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSyncing(null);
    }
  };

  const disconnectPanel = async (panel: RemotePanel) => {
    if (!confirm(`Отключить панель «${panel.name}»? Её ноды пропадут из подписок, а ваши клиенты на них будут удалены.`)) return;
    try {
      const res = await api.disconnectRemotePanel(panel.id);
      if (!res.remoteCleanup) alert('Панель отключена, но удалить клиентов на стороне партнёра не удалось — сообщите ему.');
      await load();
      onChanged();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">Загрузка...</div>;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Handshake className="w-5 h-5 text-amber-400" />
          <span>Партнёры</span>
        </h2>
        <p className="text-xs text-zinc-400 mt-0.5">
          Совместное использование нод между панелями: выдайте другу доступ к своим нодам или подключите ноды, которыми поделились с вами.
        </p>
      </div>

      {/* Выданные доступы */}
      <div className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Доступ к моим нодам</h3>
            <p className="text-[11px] text-zinc-500">Партнёры создают клиентов на ваших нодах из своих панелей</p>
          </div>
          <button
            onClick={() => setModalPartner(null)}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium px-3.5 py-2 rounded-xl"
          >
            <Plus className="w-4 h-4" />
            <span>Выдать доступ</span>
          </button>
        </div>

        {partners.length === 0 ? (
          <p className="text-xs text-zinc-500 py-4 text-center border border-dashed border-zinc-800 rounded-xl">Доступы ещё не выданы</p>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {partners.map((p) => {
              const status = !p.enabled ? 'отключён' : p.expired ? 'срок истёк' : p.suspended ? 'лимит исчерпан' : 'активен';
              const ok = status === 'активен';
              return (
                <div key={p.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <button onClick={() => setExpanded(expanded === p.id ? null : p.id)} className="text-zinc-500 hover:text-white">
                      {expanded === p.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{p.name}</span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                            ok ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                          }`}
                        >
                          {status}
                        </span>
                        <span className="text-[10px] font-mono text-zinc-600">{p.token_hint}</span>
                      </div>
                      <div className="text-[11px] text-zinc-500 mt-0.5 space-x-3">
                        <span>ноды: {p.node_ids.map(serverName).join(', ') || '—'}</span>
                        <span>
                          клиенты: {p.usage.clients}
                          {p.max_clients ? ` / ${p.max_clients}` : ''}
                        </span>
                        <span>
                          трафик: {formatBytes(p.usage.used)}
                          {p.traffic_limit ? ` / ${formatBytes(p.traffic_limit)}` : ''}
                        </span>
                        {p.expire_at && <span>до {new Date(p.expire_at).toLocaleDateString()}</span>}
                        <span>последний запрос: {formatDate(p.last_used_at)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setModalPartner(p)} title="Изменить" className={`${iconButton} hover:text-cyan-400`}>
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => regenerate(p)} title="Перевыпустить токен" className={`${iconButton} hover:text-amber-400`}>
                        <KeyRound className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => togglePartner(p)}
                        title={p.enabled ? 'Отключить доступ' : 'Включить доступ'}
                        className={`${iconButton} ${p.enabled ? 'hover:text-amber-400' : 'text-amber-400 hover:text-emerald-400'}`}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                      <button onClick={() => removePartner(p)} title="Удалить доступ" className={`${iconButton} hover:text-red-400`}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {expanded === p.id && <PartnerDetails partner={p} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Подключённые панели */}
      <div className={cardClass}>
        <div>
          <h3 className="text-sm font-semibold text-white">Ноды партнёров</h3>
          <p className="text-[11px] text-zinc-500">
            Вставьте строку подключения, которую выдал владелец нод. Его ноды появятся в списке серверов, и вы сможете выдавать их своим пользователям.
          </p>
        </div>

        <form onSubmit={handleConnect} className="flex flex-col sm:flex-row gap-2">
          <input
            required
            value={connectInput}
            onChange={(e) => setConnectInput(e.target.value)}
            placeholder="https://panel.example.com#dp_…"
            className={`${inputClass} font-mono text-xs flex-1`}
          />
          <input value={connectName} onChange={(e) => setConnectName(e.target.value)} placeholder="Название (необязательно)" className={`${inputClass} sm:w-56`} />
          <button
            type="submit"
            disabled={connecting}
            className="flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-medium px-4 py-2 rounded-xl"
          >
            {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            <span>Подключить</span>
          </button>
        </form>

        {panels.length === 0 ? (
          <p className="text-xs text-zinc-500 py-4 text-center border border-dashed border-zinc-800 rounded-xl">Панели партнёров не подключены</p>
        ) : (
          <div className="divide-y divide-zinc-800/60">
            {panels.map((panel) => {
              const statusLabel =
                panel.status === 'online' ? 'на связи' : panel.status === 'revoked' ? 'доступ отозван' : panel.status === 'pending' ? 'подключение' : 'ошибка';
              return (
                <div key={panel.id} className="py-3 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white">{panel.name}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          panel.status === 'online'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                        }`}
                      >
                        {statusLabel}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-600">{panel.base_url}</span>
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-0.5 space-x-3">
                      <span>ноды: {panel.node_count}</span>
                      <span>
                        клиенты: {panel.client_count}
                        {panel.limits?.max_clients ? ` / ${panel.limits.max_clients}` : ''}
                      </span>
                      {panel.limits && (
                        <span>
                          трафик: {formatBytes(panel.limits.usage.used)}
                          {panel.limits.traffic_limit ? ` / ${formatBytes(panel.limits.traffic_limit)}` : ''}
                        </span>
                      )}
                      {panel.limits?.expire_at && <span>до {new Date(panel.limits.expire_at).toLocaleDateString()}</span>}
                      <span>синхронизация: {formatDate(panel.last_sync_at)}</span>
                    </div>
                    {panel.last_error && <p className="text-[11px] text-amber-300 mt-1 break-all">{panel.last_error}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => syncPanel(panel)} disabled={syncing === panel.id} title="Синхронизировать" className={`${iconButton} hover:text-emerald-400`}>
                      <RefreshCw className={`w-4 h-4 ${syncing === panel.id ? 'animate-spin' : ''}`} />
                    </button>
                    <button onClick={() => disconnectPanel(panel)} title="Отключить панель" className={`${iconButton} hover:text-red-400`}>
                      <Unplug className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modalPartner !== undefined && (
        <PartnerModal
          partner={modalPartner}
          servers={servers}
          onClose={() => setModalPartner(undefined)}
          onSaved={({ connectString: cs }) => {
            setModalPartner(undefined);
            if (cs) setConnectString(cs);
            load();
          }}
        />
      )}
      {connectString && <TokenModal connectString={connectString} onClose={() => setConnectString(null)} />}
    </div>
  );
};
