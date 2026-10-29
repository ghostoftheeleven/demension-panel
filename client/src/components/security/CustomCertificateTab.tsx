import React, { useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { api } from '../../api';
import type { SslStatus } from '../../types';
import type { BannerMessage } from './SecurityBanner';
import { HTTPS_SWITCH_NOTE, switchToHttps } from './https';

interface TabProps {
  sslStatus: SslStatus | null;
  setMessage: (message: BannerMessage | null) => void;
  onReload: () => void;
}

export const CustomCertificateTab: React.FC<TabProps> = ({ sslStatus, setMessage, onReload }) => {
  const [customCert, setCustomCert] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [customDomain, setCustomDomain] = useState('');
  const [customSaving, setCustomSaving] = useState(false);

  // Save Custom
  const handleSaveCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    setCustomSaving(true);
    setMessage(null);
    try {
      await api.saveCustomCert({
        cert: customCert,
        key: customKey,
        domain: customDomain.trim() || undefined,
      });
      setMessage({ type: 'success', text: 'Пользовательский сертификат сохранён, HTTPS включён.' + HTTPS_SWITCH_NOTE });
      onReload();
      switchToHttps(customDomain.trim() || sslStatus?.domain);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCustomSaving(false);
    }
  };

  return (
        <form onSubmit={handleSaveCustom} className="space-y-4 bg-paper p-5 rounded-2xl border border-line">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Домен или IP (для идентификации)
            </label>
            <input
              type="text"
              placeholder="например: mydomain.com или 194.87.1.1"
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value)}
              className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-brand"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Сертификат (fullchain.pem)
            </label>
            <textarea
              rows={4}
              required
              placeholder="-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----"
              value={customCert}
              onChange={(e) => setCustomCert(e.target.value)}
              className="w-full bg-paper border border-line rounded-xl p-3 text-ink text-xs font-mono focus:outline-none focus:border-brand"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              Приватный ключ (privkey.pem)
            </label>
            <textarea
              rows={4}
              required
              placeholder="-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              className="w-full bg-paper border border-line rounded-xl p-3 text-ink text-xs font-mono focus:outline-none focus:border-brand"
            />
          </div>

          <button
            type="submit"
            disabled={customSaving}
            className="flex items-center gap-2 bg-violet hover:bg-violet disabled:opacity-50 text-on-accent font-bold text-xs px-5 py-2.5 rounded-full transition btn-press"
          >
            {customSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            <span>Сохранить сертификаты</span>
          </button>
        </form>
  );
};
