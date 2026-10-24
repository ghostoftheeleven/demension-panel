import React, { useEffect, useMemo, useState } from 'react';
import { Palette, Save, Loader2, ArrowUp, ArrowDown, Smartphone, Eye, Link2, Server as ServerIcon, Info } from 'lucide-react';
import type { Subscriber, SubscriptionServer, SubscriptionSettings } from '../types';
import { api } from '../api';
import { copyToClipboard } from '../utils';

const TITLE_MAX = 25;
const ANNOUNCE_MAX = 200;

const inputClass =
  'w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm';
const labelClass = 'block text-xs font-medium text-zinc-400 mb-1';
const cardClass = 'bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-6 shadow-xl space-y-4';

function renderTitle(template: string, user: string): string {
  const title = (template || '{user}').split('{user}').join(user);
  const chars = [...title];
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join('') + '…' : title;
}

const CLIENTS: { name: string; platforms: string; format: string; note?: string }[] = [
  { name: 'Incy', platforms: 'iOS, Android', format: 'Основная ссылка', note: 'Поддерживает все заголовки этой страницы' },
  { name: 'Clash Verge Rev', platforms: 'Windows, macOS, Linux', format: 'Ссылка mihomo', note: 'Определяется автоматически' },
  { name: 'FlClash', platforms: 'Android, Windows, macOS, Linux', format: 'Ссылка mihomo', note: 'Определяется автоматически' },
  { name: 'Mihomo Party', platforms: 'Windows, macOS, Linux', format: 'Ссылка mihomo' },
  { name: 'Clash Meta for Android', platforms: 'Android', format: 'Ссылка mihomo' },
  { name: 'AmneziaWG / Amnezia VPN', platforms: 'все', format: '—', note: 'Подписки не поддерживают — только .conf или QR отдельного клиента' },
  { name: 'HAPP, v2rayNG, Karing', platforms: '—', format: '—', note: 'AmneziaWG не поддерживают' },
];

export const SubscriptionSettingsView: React.FC<{ subscribers: Subscriber[]; publicUrl: string | null }> = ({
  subscribers,
  publicUrl,
}) => {
  const [settings, setSettings] = useState<SubscriptionSettings | null>(null);
  const [servers, setServers] = useState<SubscriptionServer[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);

  useEffect(() => {
    api
      .getSubscriptionSettings()
      .then((data) => {
        setSettings(data.settings);
        setServers(data.servers);
      })
      .catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  const previewSubscriber = subscribers.find((s) => s.id === previewId) || subscribers[0] || null;

  const previewServers = useMemo(() => {
    if (!previewSubscriber) return servers;
    const ids = new Set(previewSubscriber.server_ids);
    return servers.filter((s) => ids.has(s.id));
  }, [servers, previewSubscriber]);

  if (!settings) {
    return message ? (
      <div className="p-4 rounded-2xl border bg-red-500/10 border-red-500/20 text-red-300 text-xs">{message.text}</div>
    ) : (
      <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">Загрузка настроек подписки...</div>
    );
  }

  const update = <K extends keyof SubscriptionSettings>(key: K, value: SubscriptionSettings[K]) =>
    setSettings({ ...settings, [key]: value });

  const titleLength = [...settings.title.split('{user}').join('')].length;
  const announceLength = [...settings.announce].length;

  const moveServer = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= servers.length) return;
    const next = [...servers];
    [next[index], next[target]] = [next[target], next[index]];
    setServers(next.map((s, i) => ({ ...s, sub_order: i })));
  };

  const renameServer = (id: number, subName: string) => {
    setServers(servers.map((s) => (s.id === id ? { ...s, sub_name: subName } : s)));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const data = await api.updateSubscriptionSettings({
        settings: { ...settings, update_interval: Number(settings.update_interval) },
        servers: servers.map((s, i) => ({ id: s.id, sub_name: s.sub_name || '', sub_order: i })),
      });
      setSettings(data.settings);
      setServers(data.servers);
      setMessage({
        type: 'success',
        text: 'Сохранено. Приложения получат изменения при следующем обновлении подписки (или после ручного обновления).',
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const baseUrl = previewSubscriber ? api.getSubscriptionUrl(previewSubscriber.token, publicUrl) : '';
  const links = previewSubscriber
    ? [
        { label: 'Основная (Incy)', url: baseUrl },
        { label: 'mihomo / Clash Meta', url: `${baseUrl}?format=clash` },
        { label: 'JSON-контейнер Incy', url: `${baseUrl}?format=json` },
      ]
    : [];

  return (
    <form onSubmit={handleSave} className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Palette className="w-5 h-5 text-purple-400" />
            <span>Оформление подписки</span>
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Как подписка выглядит в приложении Incy: название, объявление, ссылки поддержки и имена серверов
          </p>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm px-5 py-2.5 rounded-xl transition shadow-lg shadow-emerald-600/20"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>Сохранить</span>
        </button>
      </div>

      {message && (
        <div
          className={`p-4 rounded-2xl border text-xs ${
            message.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              : 'bg-red-500/10 border-red-500/20 text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Appearance */}
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-white">Внешний вид</h3>

            <div>
              <label className={labelClass}>
                Название подписки <span className="text-zinc-600">({titleLength}/{TITLE_MAX}, без учёта {'{user}'})</span>
              </label>
              <input value={settings.title} onChange={(e) => update('title', e.target.value)} className={inputClass} placeholder="{user}" />
              <p className="text-[11px] text-zinc-500 mt-1">
                <code className="text-zinc-400">{'{user}'}</code> заменяется именем пользователя. Длинные названия обрезаются до 25 символов.
              </p>
            </div>

            <div>
              <label className={labelClass}>Описание</label>
              <textarea
                rows={2}
                value={settings.description}
                onChange={(e) => update('description', e.target.value)}
                className={inputClass}
                placeholder="Например: Быстрые серверы в Европе"
              />
            </div>

            <div>
              <label className={labelClass}>
                Объявление на главном экране <span className="text-zinc-600">({announceLength}/{ANNOUNCE_MAX})</span>
              </label>
              <textarea
                rows={3}
                maxLength={ANNOUNCE_MAX * 2}
                value={settings.announce}
                onChange={(e) => update('announce', e.target.value)}
                className={inputClass}
                placeholder="Например: 15 ноября плановые работы с 02:00 до 04:00"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Обновление, ч</label>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={settings.update_interval}
                  onChange={(e) => update('update_interval', Number(e.target.value))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Сортировка серверов</label>
                <select
                  value={settings.sort_order}
                  onChange={(e) => update('sort_order', e.target.value as SubscriptionSettings['sort_order'])}
                  className={inputClass}
                >
                  <option value="">Настройка приложения</option>
                  <option value="none">Как в панели</option>
                  <option value="ping">По пингу</option>
                  <option value="name">По имени</option>
                </select>
              </div>
              <label className="flex items-end gap-2 text-xs text-zinc-400 pb-2 cursor-pointer">
                <input type="checkbox" checked={settings.hide_url} onChange={(e) => update('hide_url', e.target.checked)} />
                <span>Скрыть ссылку подписки от пользователя</span>
              </label>
            </div>
          </div>

          {/* Links */}
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-white">Ссылки и поддержка</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Поддержка (Telegram, сайт)</label>
                <input type="url" value={settings.support_url} onChange={(e) => update('support_url', e.target.value)} className={inputClass} placeholder="https://t.me/support" />
              </div>
              <div>
                <label className={labelClass}>Email поддержки</label>
                <input type="email" value={settings.support_email} onChange={(e) => update('support_email', e.target.value)} className={inputClass} placeholder="support@example.com" />
              </div>
              <div>
                <label className={labelClass}>Сайт</label>
                <input type="url" value={settings.web_page_url} onChange={(e) => update('web_page_url', e.target.value)} className={inputClass} placeholder="https://example.com" />
              </div>
              <div>
                <label className={labelClass}>Ссылка из объявления</label>
                <input type="url" value={settings.announce_url} onChange={(e) => update('announce_url', e.target.value)} className={inputClass} placeholder="https://example.com/news" />
              </div>
            </div>
          </div>

          {/* Servers */}
          <div className={cardClass}>
            <div>
              <h3 className="text-sm font-semibold text-white">Серверы в подписке</h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Имя, которое увидит пользователь (можно с эмодзи флага), и порядок в списке. Пустое поле — имя сервера в панели.
              </p>
            </div>
            {servers.length === 0 ? (
              <p className="text-xs text-zinc-500">Серверы ещё не добавлены.</p>
            ) : (
              <div className="space-y-2">
                {servers.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <div className="flex flex-col">
                      <button type="button" onClick={() => moveServer(i, -1)} disabled={i === 0} className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30" title="Выше">
                        <ArrowUp className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => moveServer(i, 1)} disabled={i === servers.length - 1} className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30" title="Ниже">
                        <ArrowDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="w-40 flex-shrink-0 min-w-0">
                      <p className="text-xs font-medium text-zinc-200 truncate">{s.name}</p>
                      <p className="text-[10px] font-mono text-zinc-500 truncate">{s.host}</p>
                    </div>
                    <input
                      value={s.sub_name || ''}
                      maxLength={64}
                      onChange={(e) => renameServer(s.id, e.target.value)}
                      placeholder={s.name}
                      className={inputClass}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Preview & compatibility */}
        <div className="space-y-6">
          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Eye className="w-4 h-4 text-emerald-400" />
              <span>Предпросмотр</span>
            </h3>
            {subscribers.length > 0 && (
              <select
                value={previewSubscriber?.id ?? ''}
                onChange={(e) => setPreviewId(Number(e.target.value))}
                className={inputClass}
              >
                {subscribers.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.name}
                  </option>
                ))}
              </select>
            )}
            <div className="rounded-2xl bg-zinc-950 border border-zinc-800 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-zinc-500" />
                <span className="text-sm font-semibold text-white">{renderTitle(settings.title, previewSubscriber?.name || 'Пользователь')}</span>
              </div>
              {settings.description && <p className="text-xs text-zinc-400 whitespace-pre-line">{settings.description}</p>}
              {settings.announce && (
                <p className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2 whitespace-pre-line line-clamp-5">
                  {settings.announce}
                </p>
              )}
              <div className="space-y-1">
                {previewServers.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">Нет серверов</p>
                ) : (
                  previewServers.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 text-xs text-zinc-200 bg-zinc-900 rounded-lg px-2.5 py-1.5">
                      <ServerIcon className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                      <span className="truncate">{s.sub_name || s.name}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {links.length > 0 && (
              <div className="space-y-2">
                {links.map((link) => (
                  <button
                    key={link.label}
                    type="button"
                    onClick={() => copyToClipboard(link.url).then((ok) => !ok && alert(link.url))}
                    className="w-full flex items-center gap-2 text-left text-[11px] bg-zinc-950 border border-zinc-800 hover:border-emerald-500/40 rounded-lg px-2.5 py-2 transition"
                    title="Скопировать ссылку"
                  >
                    <Link2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    <span className="text-zinc-300 font-medium flex-shrink-0">{link.label}</span>
                    <span className="text-zinc-600 font-mono truncate">{link.url}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={cardClass}>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Info className="w-4 h-4 text-cyan-400" />
              <span>Клиенты с поддержкой AmneziaWG</span>
            </h3>
            <div className="space-y-2.5">
              {CLIENTS.map((c) => (
                <div key={c.name} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-zinc-200">{c.name}</span>
                    <span className="text-[10px] text-zinc-500 text-right">{c.format}</span>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    {c.platforms}
                    {c.note ? ` · ${c.note}` : ''}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-600">
              Клиенты mihomo распознаются по User-Agent и получают свой формат по основной ссылке. Заголовки оформления понимает только Incy.
            </p>
          </div>
        </div>
      </div>
    </form>
  );
};
