import React, { useState } from 'react';
import { Lock, AlertTriangle, Loader2, Server } from 'lucide-react';
import { api } from '../../api';
import type { SslStatus } from '../../types';
import type { BannerMessage } from './SecurityBanner';
import { HTTPS_SWITCH_NOTE, switchToHttps } from './https';

interface TabProps {
  sslStatus?: SslStatus | null;
  setMessage: (message: BannerMessage | null) => void;
  onReload: () => void;
}

export const IpCertificateTab: React.FC<TabProps> = ({ setMessage, onReload }) => {
  const [ipTarget, setIpTarget] = useState('');
  const [ipIssuing, setIpIssuing] = useState(false);

  // Issue IP self-signed
  const handleIssueIp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ipTarget.trim()) return;
    setIpIssuing(true);
    setMessage(null);
    try {
      await api.issueSelfSignedIp(ipTarget.trim());
      setMessage({
        type: 'success',
        text:
          `🎉 Самоподписанный сертификат для ${ipTarget} установлен. Браузер покажет предупреждение — это ожидаемо. ` +
          'Подписки по https:// с таким сертификатом в приложениях работать не будут (http-ссылки работают, но без шифрования) — ' +
          'для подписок нужен домен и сертификат Let\'s Encrypt.' +
          HTTPS_SWITCH_NOTE,
      });
      onReload();
      switchToHttps(ipTarget.trim());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setIpIssuing(false);
    }
  };

  return (
        <form onSubmit={handleIssueIp} className="space-y-4 bg-paper p-5 rounded-2xl border border-line">
          <div className="flex items-start gap-2 text-xs text-muted">
            <Server className="w-4 h-4 text-info flex-shrink-0 mt-0.5" />
            <span>
              Генерация сертификата со встроенным Subject Alternative Name (SAN IP) непосредственно для IP-адреса вашего сервера (если у вас нет домена).
            </span>
          </div>

          <div className="p-3 bg-warn-soft border border-line rounded-xl text-warn text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              <b>Подписки с таким сертификатом работать не будут.</b> Сертификат самоподписанный, поэтому приложения (Incy, Clash и др.)
              не откроют ссылки подписок по <code>https://</code>. Ссылки по <code>http://</code> продолжат работать, но ключи клиентов
              в них передаются без шифрования. Для подписок используйте домен и сертификат Let's Encrypt.
            </span>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted mb-1">
              IP-адрес сервера
            </label>
            <input
              type="text"
              required
              placeholder="например: 194.87.12.34"
              value={ipTarget}
              onChange={(e) => setIpTarget(e.target.value)}
              className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs font-mono focus:outline-none focus:border-brand"
            />
          </div>

          <button
            type="submit"
            disabled={ipIssuing || !ipTarget.trim()}
            className="flex items-center gap-2 bg-blue hover:bg-blue disabled:opacity-50 text-on-accent font-bold text-xs px-5 py-2.5 rounded-full transition btn-press"
          >
            {ipIssuing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
            <span>Сгенерировать сертификат для IP</span>
          </button>
        </form>
  );
};
