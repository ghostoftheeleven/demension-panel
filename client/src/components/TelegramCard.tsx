import React, { useEffect, useState } from 'react';
import { Loader2, Save, Send } from 'lucide-react';
import { api } from '../api';
import type { TelegramSettings } from '../types';

export const TelegramCard: React.FC = () => {
  const [form, setForm] = useState<TelegramSettings | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { api.getTelegramSettings().then(setForm).catch((err) => setMessage({ ok: false, text: err.message })); }, []);
  if (!form) return null;

  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      const saved = await api.updateTelegramSettings({ ...form, bot_token: token || undefined });
      setForm(saved); setToken(''); setMessage({ ok: true, text: 'Настройки Telegram сохранены' });
    } catch (err: any) { setMessage({ ok: false, text: err.message }); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMessage(null);
    try {
      const result = await api.testTelegram();
      setMessage({ ok: result.success, text: result.message });
    } catch (err: any) { setMessage({ ok: false, text: err.message }); }
    finally { setBusy(false); }
  };

  const canTest = (form.bot_token_saved || token.trim().length > 0) && form.chat_id.trim().length > 0;

  return (
    <section className="bg-card border border-line rounded-2xl p-6 space-y-4">
      <div className="flex items-center gap-2"><Send className="w-5 h-5 text-info" /><h3 className="text-base font-semibold text-ink">Уведомления в Telegram</h3></div>
      {message && <div className={`p-3 rounded-xl border border-line text-xs ${message.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>{message.text}</div>}
      <label className="flex items-center gap-3 text-sm text-ink"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Отправлять уведомления администратору</label>
      <div className="grid md:grid-cols-2 gap-4">
        <div><label htmlFor="telegram-token" className="block text-xs text-muted mb-1">Токен бота</label><input id="telegram-token" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={form.bot_token_saved ? 'Сохранён — введите новый для замены' : '123456:…'} className="w-full bg-paper border border-line rounded-xl px-3 py-2 text-sm text-ink" /></div>
        <div><label htmlFor="telegram-chat-id" className="block text-xs text-muted mb-1">ID чата</label><input id="telegram-chat-id" value={form.chat_id} onChange={(e) => setForm({ ...form, chat_id: e.target.value })} placeholder="12345 или -100…" className="w-full bg-paper border border-line rounded-xl px-3 py-2 text-sm text-ink" /></div>
      </div>
      <label className="flex items-center gap-3 text-sm text-ink"><input type="checkbox" checked={form.notify_info} onChange={(e) => setForm({ ...form, notify_info: e.target.checked })} />Отправлять также информационные события</label>
      <p className="text-xs text-faint">По умолчанию отправляются только предупреждения и ошибки. Токен хранится зашифрованным.</p>
      <div className="flex justify-end gap-2">
        <button disabled={busy || !canTest} onClick={() => void test()} className="flex items-center gap-2 px-4 py-2 rounded-full bg-paper text-ink text-sm disabled:opacity-50"><Send className="w-4 h-4" />Проверить</button>
        <button disabled={busy} onClick={() => void save()} className="flex items-center gap-2 px-4 py-2 rounded-full bg-mint text-on-accent text-sm font-bold disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Сохранить</button>
      </div>
    </section>
  );
};
