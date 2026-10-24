import React, { useEffect, useState } from 'react';
import { Settings2, Save, Loader2 } from 'lucide-react';
import type { PanelSettings } from '../types';
import { api } from '../api';

const inputClass =
  'w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2 text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500 transition text-sm';

export const PanelSettingsCard: React.FC<{ onSaved?: (settings: PanelSettings) => void }> = ({ onSaved }) => {
  const [form, setForm] = useState<PanelSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.getSettings().then(setForm).catch((err) => setMessage({ type: 'error', text: err.message }));
  }, []);

  if (!form) return null;

  const update = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]) => setForm({ ...form, [key]: value });

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api.updateSettings({
        ...form,
        client_mtu: Number(form.client_mtu),
        sub_update_interval: Number(form.sub_update_interval),
      });
      setForm(saved);
      onSaved?.(saved);
      setMessage({
        type: 'success',
        text: 'Настройки сохранены. DNS и MTU применятся к новым конфигам и при следующем обновлении подписок.',
      });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-6 shadow-xl space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="w-5 h-5 text-emerald-400" />
        <h3 className="text-base font-semibold text-white">Настройки панели</h3>
      </div>

      {message && (
        <div
          className={`p-3 rounded-xl border text-xs ${
            message.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              : 'bg-red-500/10 border-red-500/20 text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-zinc-400 mb-1">Публичный адрес панели (для ссылок подписок)</label>
          <input
            type="url"
            placeholder={window.location.origin}
            value={form.public_url}
            onChange={(e) => update('public_url', e.target.value)}
            className={inputClass}
          />
          <p className="text-[11px] text-zinc-500 mt-1">
            Укажите, если панель открыта через SSH-туннель, localhost или внутренний адрес — иначе пользователи получат нерабочую ссылку.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">DNS для клиентов</label>
          <input value={form.client_dns} onChange={(e) => update('client_dns', e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">MTU клиентов</label>
          <input
            type="number"
            min={576}
            max={1500}
            value={form.client_mtu}
            onChange={(e) => update('client_mtu', Number(e.target.value))}
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">Интервал обновления подписки, ч</label>
          <input
            type="number"
            min={1}
            max={168}
            value={form.sub_update_interval}
            onChange={(e) => update('sub_update_interval', Number(e.target.value))}
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">Название подписки (до 25 символов)</label>
          <input
            maxLength={25}
            placeholder="имя пользователя"
            value={form.sub_title}
            onChange={(e) => update('sub_title', e.target.value)}
            className={inputClass}
          />
        </div>

        <div className="md:col-span-2">
          <label className="block text-xs font-medium text-zinc-400 mb-1">Docker-образ AmneziaWG для новых установок</label>
          <input value={form.awg_image} onChange={(e) => update('awg_image', e.target.value)} className={`${inputClass} font-mono text-xs`} />
          <p className="text-[11px] text-zinc-500 mt-1">
            По умолчанию зафиксирована проверенная версия. Образ собран только для amd64.
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium text-sm px-5 py-2 rounded-xl transition"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span>Сохранить</span>
        </button>
      </div>
    </form>
  );
};
