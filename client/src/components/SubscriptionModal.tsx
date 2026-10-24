import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { X, Link2, Copy, Check, QrCode, RefreshCw, Server as ServerIcon, Smartphone } from 'lucide-react';
import type { Subscriber } from '../types';
import { api } from '../api';
import { copyToClipboard } from '../utils';

interface SubscriptionModalProps {
  isOpen: boolean;
  subscriber: Subscriber | null;
  onClose: () => void;
  onTokenReset: (updated: Subscriber) => void;
  /** Публичный адрес панели из настроек (если панель открыта через туннель/внутренний адрес) */
  publicUrl?: string | null;
}

export const SubscriptionModal: React.FC<SubscriptionModalProps> = ({
  isOpen,
  subscriber,
  onClose,
  onTokenReset,
  publicUrl,
}) => {
  const [copied, setCopied] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const subUrl = subscriber ? api.getSubscriptionUrl(subscriber.token, publicUrl) : '';

  useEffect(() => {
    if (!subUrl) {
      setQrCodeUrl(null);
      return;
    }

    QRCode.toDataURL(subUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 300,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => setQrCodeUrl(url))
      .catch(() => {});
  }, [subUrl]);

  if (!isOpen || !subscriber) return null;

  const handleCopy = async () => {
    if (await copyToClipboard(subUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      alert('Не удалось скопировать — выделите ссылку вручную');
    }
  };

  const handleResetToken = async () => {
    if (!confirm('Сбросить ссылку подписки? Старая ссылка перестанет работать, а ключи пользователя будут перевыпущены — на всех устройствах нужно будет добавить новую подписку.')) return;
    setResetting(true);
    try {
      const res = await api.resetSubscriberToken(subscriber.id);
      onTokenReset({ ...subscriber, token: res.token });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-2.5">
            <Link2 className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-base font-semibold text-white">Подписка AmneziaWG</h2>
              <p className="text-xs text-zinc-400">Пользователь: {subscriber.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white transition p-1 rounded-lg hover:bg-zinc-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Active Nodes Summary */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-2">
              Доступные ноды ({subscriber.servers.length}):
            </label>
            <div className="flex flex-wrap gap-1.5">
              {subscriber.servers.length === 0 ? (
                <span className="text-xs text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-lg border border-amber-400/20">
                  Нет назначенных нод. Выберите серверы в настройках пользователя.
                </span>
              ) : (
                subscriber.servers.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-zinc-950 border border-zinc-800 text-zinc-200"
                  >
                    <ServerIcon className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{s.name}</span>
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Subscription URL Field */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-zinc-400">
                Ссылка на подписку:
              </label>
              <button
                onClick={handleResetToken}
                disabled={resetting}
                className="text-[11px] text-zinc-500 hover:text-amber-400 transition flex items-center gap-1"
                title="Сгенерировать новый секретный токен"
              >
                <RefreshCw className={`w-3 h-3 ${resetting ? 'animate-spin' : ''}`} />
                <span>Сбросить ссылку</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={subUrl}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-zinc-300 font-mono focus:outline-none select-all"
              />
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-4 py-2.5 rounded-xl transition shadow-lg shadow-emerald-600/20 flex-shrink-0"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'Скопировано!' : 'Копировать'}</span>
              </button>
            </div>
          </div>

          {/* QR Code */}
          {qrCodeUrl && (
            <div className="flex flex-col items-center space-y-2 pt-1">
              <div className="p-3 bg-white rounded-2xl shadow-xl">
                <img
                  src={qrCodeUrl}
                  alt="Subscription QR Code"
                  className="w-52 h-52 object-contain rounded-lg"
                />
              </div>
              <p className="text-xs text-zinc-400 text-center flex items-center gap-1.5 pt-1">
                <QrCode className="w-3.5 h-3.5 text-emerald-400" />
                <span>Отсканируйте камерой в приложении <strong>Incy</strong> (iOS / Android)</span>
              </p>
            </div>
          )}

          {/* HAPP & Incy Compatibility Notice */}
          <div className="p-4 bg-zinc-950/70 border border-zinc-800 rounded-2xl space-y-2 text-xs text-zinc-400">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold">
              <Smartphone className="w-4 h-4" />
              <span>Автоматическое обновление серверов (Auto-sync)</span>
            </div>
            <p>
              При добавлении или удалении серверов в панели список в приложении <strong>Incy</strong> обновится автоматически.
              Та же ссылка работает в Clash Verge Rev, FlClash и других клиентах на ядре mihomo (формат подбирается автоматически).
              HAPP не поддерживает AmneziaWG.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-zinc-800 bg-zinc-900/40 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-xs font-medium transition"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
