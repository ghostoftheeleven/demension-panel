import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Lock,
  Cloud,
  Globe,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Unlock,
  Ban,
  Server,
  Power,
} from 'lucide-react';
import type { SslStatus, Fail2banStatus, CloudflareZone, PanelSettings } from '../types';
import { api } from '../api';
import { PanelSettingsCard } from './PanelSettingsCard';
import { MigrationCard } from './MigrationCard';

/**
 * HTTPS включается сразу (без перезапуска). Открытая по HTTP панель после этого
 * перестаёт принимать API-запросы, поэтому переходим на HTTPS-адрес.
 */
function switchToHttps(domain?: string | null) {
  if (window.location.protocol === 'https:') return;
  const isIp = !domain || /^[\d.]+$/.test(domain) || domain.includes(':');
  const host = isIp ? window.location.hostname : domain;
  const port = window.location.port ? `:${window.location.port}` : '';
  setTimeout(() => {
    window.location.href = `https://${host}${port}${window.location.pathname}`;
  }, 2500);
}

const HTTPS_SWITCH_NOTE = ' Через пару секунд панель откроется по HTTPS. Старые http-ссылки подписок продолжат работать.';

export const SecurityView: React.FC<{
  publicUrl: string | null;
  onSettingsSaved?: (settings: PanelSettings) => void;
  onMigrationChange?: () => void;
}> = ({ publicUrl, onSettingsSaved, onMigrationChange }) => {
  const [sslStatus, setSslStatus] = useState<SslStatus | null>(null);
  const [f2bStatus, setF2bStatus] = useState<Fail2banStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // SSL Form state
  const [sslTab, setSslTab] = useState<'cf' | 'http' | 'ip' | 'custom'>('cf');

  // Cloudflare tab
  const [cfToken, setCfToken] = useState('');
  const [cfValid, setCfValid] = useState<boolean | null>(null);
  const [cfVerifying, setCfVerifying] = useState(false);
  const [cfZones, setCfZones] = useState<CloudflareZone[]>([]);
  const [cfDomain, setCfDomain] = useState('');
  const [cfEmail, setCfEmail] = useState('');
  const [cfCreateARecord, setCfCreateARecord] = useState(true);
  const [cfIssuing, setCfIssuing] = useState(false);

  // HTTP-01 tab
  const [httpDomain, setHttpDomain] = useState('');
  const [httpEmail, setHttpEmail] = useState('');
  const [httpIssuing, setHttpIssuing] = useState(false);

  // IP tab
  const [ipTarget, setIpTarget] = useState('');
  const [ipIssuing, setIpIssuing] = useState(false);

  // Custom tab
  const [customCert, setCustomCert] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [customDomain, setCustomDomain] = useState('');
  const [customSaving, setCustomSaving] = useState(false);

  // Fail2ban manual ban
  const [manualBanIp, setManualBanIp] = useState('');
  const [banning, setBanning] = useState(false);
  const [f2bSettingUp, setF2bSettingUp] = useState(false);

  // Message banner
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadSecurityData = async () => {
    try {
      const [ssl, f2b] = await Promise.all([api.getSslStatus(), api.getFail2banStatus()]);
      setSslStatus(ssl);
      setF2bStatus(f2b);
    } catch (err: any) {
      console.error('Ошибка загрузки статуса безопасности:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSecurityData();
  }, []);

  // Cloudflare token check
  const handleVerifyCfToken = async () => {
    if (!cfToken.trim()) return;
    setCfVerifying(true);
    setCfValid(null);
    try {
      const res = await api.verifyCloudflareToken(cfToken.trim());
      setCfValid(res.valid);
      if (res.valid) {
        const zones = await api.getCloudflareZones(cfToken.trim());
        setCfZones(zones);
        setMessage({ type: 'success', text: 'Токен Cloudflare подтвержден! Найдено зон: ' + zones.length });
      } else {
        setMessage({ type: 'error', text: res.message });
      }
    } catch (err: any) {
      setCfValid(false);
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCfVerifying(false);
    }
  };

  // Issue via Cloudflare
  const handleIssueCf = async (e: React.FormEvent) => {
    e.preventDefault();
    setCfIssuing(true);
    setMessage(null);
    try {
      await api.issueLetsEncryptCf({
        domain: cfDomain.trim(),
        email: cfEmail.trim(),
        token: cfToken.trim(),
        createARecord: cfCreateARecord,
      });
      setMessage({
        type: 'success',
        text: `🎉 Сертификат Let's Encrypt для ${cfDomain} выпущен, HTTPS включён, автопродление настроено.` + HTTPS_SWITCH_NOTE,
      });
      loadSecurityData();
      switchToHttps(cfDomain.trim());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCfIssuing(false);
    }
  };

  // Issue via HTTP-01
  const handleIssueHttp = async (e: React.FormEvent) => {
    e.preventDefault();
    setHttpIssuing(true);
    setMessage(null);
    try {
      await api.issueLetsEncryptHttp({
        domain: httpDomain.trim(),
        email: httpEmail.trim(),
      });
      setMessage({
        type: 'success',
        text: `🎉 Сертификат Let's Encrypt для ${httpDomain} выпущен, HTTPS включён, автопродление настроено.` + HTTPS_SWITCH_NOTE,
      });
      loadSecurityData();
      switchToHttps(httpDomain.trim());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setHttpIssuing(false);
    }
  };

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
      loadSecurityData();
      switchToHttps(ipTarget.trim());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setIpIssuing(false);
    }
  };

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
      loadSecurityData();
      switchToHttps(customDomain.trim() || sslStatus?.domain);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCustomSaving(false);
    }
  };

  // Toggle SSL
  const handleToggleSsl = async () => {
    if (!sslStatus) return;
    try {
      const targetState = !sslStatus.enabled;
      await api.toggleSsl(targetState);
      setSslStatus({ ...sslStatus, enabled: targetState });
      setMessage({
        type: 'success',
        text: targetState
          ? 'HTTPS активирован.' + HTTPS_SWITCH_NOTE
          : 'HTTPS отключен. Панель работает по обычному HTTP.',
      });
      if (targetState) switchToHttps(sslStatus.domain);
      else if (window.location.protocol === 'https:') {
        setTimeout(() => {
          window.location.href = `http://${window.location.host}${window.location.pathname}`;
        }, 2000);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  // Unban IP
  const handleUnban = async (ip: string) => {
    try {
      await api.unbanIp(ip);
      setMessage({ type: 'success', text: `IP ${ip} успешно разблокирован` });
      loadSecurityData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  // Manual Ban
  const handleManualBan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualBanIp.trim()) return;
    setBanning(true);
    try {
      await api.banIp(manualBanIp.trim());
      setMessage({ type: 'success', text: `IP ${manualBanIp} заблокирован` });
      setManualBanIp('');
      loadSecurityData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBanning(false);
    }
  };

  // Setup Fail2ban
  const handleSetupFail2ban = async () => {
    setF2bSettingUp(true);
    setMessage(null);
    try {
      const res = await api.setupFail2ban();
      setMessage({ type: 'success', text: res.message });
      loadSecurityData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setF2bSettingUp(false);
    }
  };

  if (loading) {
    return <div className="text-center py-24 text-faint text-sm">Загрузка настроек безопасности...</div>;
  }

  return (
    <div className="space-y-8">
      <PanelSettingsCard onSaved={onSettingsSaved} />

      {/* Notification banner */}
      {message && (
        <div
          className={`p-4 rounded-2xl border text-xs flex items-center justify-between ${
            message.type === 'success'
              ? 'bg-ok-soft border-line text-ok'
              : 'bg-bad-soft border-line text-bad'
          }`}
        >
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="text-muted hover:text-ink">
            &times;
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SECTION 1: HTTPS & SSL Certificates */}
      {/* ========================================================================= */}
      <div className="bg-card border border-line rounded-2xl p-6 sm:p-8 shadow-pop space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-ok-soft border border-line flex items-center justify-center">
              <Lock className="w-5 h-5 text-ok" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink tracking-wide">Настройка HTTPS (SSL)</h2>
              <p className="text-xs text-muted">
                Защита панели шифрованием, автовыпуск Let's Encrypt через Cloudflare DNS или сертификат на IP
              </p>
            </div>
          </div>

          {/* SSL Status Badge and Toggle */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  sslStatus?.enabled ? 'bg-mint  ' : 'bg-faint'
                }`}
              />
              <span className="text-xs font-semibold text-ink">
                {sslStatus?.enabled ? 'HTTPS АКТИВЕН' : 'HTTP (НЕ ЗАЩИЩЕНО)'}
              </span>
            </div>

            <button
              onClick={handleToggleSsl}
              disabled={!sslStatus?.hasCert}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition ${
                sslStatus?.enabled
                  ? 'bg-soft text-ink hover:bg-soft-2'
                  : 'bg-mint hover:bg-mint text-on-accent disabled:opacity-40'
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              <span>{sslStatus?.enabled ? 'Выключить HTTPS' : 'Включить HTTPS'}</span>
            </button>
          </div>
        </div>

        {/* Current Certificate Details */}
        {sslStatus?.hasCert && (
          <div className="p-4 bg-paper border border-line rounded-2xl flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="space-y-1">
              <span className="text-faint font-medium">Активный сертификат:</span>
              <div className="flex items-center gap-2 font-mono text-ink">
                <Globe className="w-3.5 h-3.5 text-ok" />
                <span>{sslStatus.domain || 'Сертификат установлен'}</span>
              </div>
            </div>

            <div className="space-y-1">
              <span className="text-faint font-medium">Режим выпуска:</span>
              <div className="text-ink font-semibold uppercase">
                {sslStatus.mode === 'letsencrypt_cf'
                  ? 'Let’s Encrypt (Cloudflare DNS)'
                  : sslStatus.mode === 'letsencrypt_http'
                  ? 'Let’s Encrypt (HTTP-01)'
                  : sslStatus.mode === 'selfsigned_ip'
                  ? 'IP SAN Certificate'
                  : 'Пользовательский PEM'}
              </div>
            </div>

            {sslStatus.expiresAt && (
              <div className="space-y-1">
                <span className="text-faint font-medium">Действителен до:</span>
                <div className="text-ok font-mono">
                  {new Date(sslStatus.expiresAt).toLocaleDateString()}
                </div>
              </div>
            )}
          </div>
        )}

        {/* SSL Method Tabs */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 border-b border-line pb-2 overflow-x-auto">
            <button
              onClick={() => setSslTab('cf')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'cf' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <Cloud className="w-4 h-4 text-warn" />
              <span>Cloudflare API (Рекомендуется)</span>
            </button>

            <button
              onClick={() => setSslTab('ip')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'ip' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <Server className="w-4 h-4 text-info" />
              <span>Сертификат на IP-адрес</span>
            </button>

            <button
              onClick={() => setSslTab('http')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'http' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <Globe className="w-4 h-4 text-ok" />
              <span>Let's Encrypt (HTTP-01)</span>
            </button>

            <button
              onClick={() => setSslTab('custom')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium transition ${
                sslTab === 'custom' ? 'bg-soft text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <FileText className="w-4 h-4 text-accent" />
              <span>Свой сертификат (PEM)</span>
            </button>
          </div>

          {/* Tab 1: Cloudflare API */}
          {sslTab === 'cf' && (
            <form onSubmit={handleIssueCf} className="space-y-4 bg-paper p-5 rounded-2xl border border-line">
              <div className="flex items-start gap-2 text-xs text-muted">
                <Cloud className="w-4 h-4 text-warn flex-shrink-0 mt-0.5" />
                <span>
                  Панель автоматически добавит временную запись DNS <code>_acme-challenge</code> через API Cloudflare и выпустит сертификат Let's Encrypt без необходимости открывать 80-й порт.
                </span>
              </div>

              {/* Cloudflare Token Input with Verify button */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  API Токен Cloudflare (с разрешениями Zone:DNS:Edit)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    required
                    placeholder="Вставьте токен из Cloudflare Dashboard..."
                    value={cfToken}
                    onChange={(e) => {
                      setCfToken(e.target.value);
                      setCfValid(null);
                    }}
                    className="flex-1 min-w-0 bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs font-mono focus:outline-none focus:border-mint"
                  />
                  <button
                    type="button"
                    onClick={handleVerifyCfToken}
                    disabled={cfVerifying || !cfToken.trim()}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-soft hover:bg-soft-2 text-ink rounded-xl transition disabled:opacity-50 border border-line"
                  >
                    {cfVerifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 text-ok" />}
                    <span>{cfValid ? 'Подтвержден' : 'Проверить'}</span>
                  </button>
                </div>
              </div>

              {cfZones.length > 0 && (
                <div className="text-xs text-faint">
                  Доступные домены в Cloudflare: {cfZones.map((z) => z.name).join(', ')}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    Доменное имя для панели
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="например: panel.example.com"
                    value={cfDomain}
                    onChange={(e) => setCfDomain(e.target.value)}
                    className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-mint"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    Email для уведомлений Let's Encrypt
                  </label>
                  <input
                    type="email"
                    required
                    placeholder="admin@example.com"
                    value={cfEmail}
                    onChange={(e) => setCfEmail(e.target.value)}
                    className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-mint"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="cfARecord"
                  checked={cfCreateARecord}
                  onChange={(e) => setCfCreateARecord(e.target.checked)}
                  className="rounded border-line text-ok focus:ring-0"
                />
                <label htmlFor="cfARecord" className="text-xs text-ink cursor-pointer">
                  Автоматически добавить или обновить A-запись в Cloudflare на IP-адрес этого сервера
                </label>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={cfIssuing || !cfToken.trim()}
                  className="flex items-center gap-2 bg-mint disabled:opacity-50 text-on-accent font-bold text-xs px-5 py-2.5 rounded-full transition btn-press"
                >
                  {cfIssuing ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Выпуск сертификата (проверка DNS)...</span>
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5" />
                      <span>Выпустить сертификат Let's Encrypt через Cloudflare</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {/* Tab 2: IP Certificate */}
          {sslTab === 'ip' && (
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
                  className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs font-mono focus:outline-none focus:border-mint"
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
          )}

          {/* Tab 3: HTTP-01 */}
          {sslTab === 'http' && (
            <form onSubmit={handleIssueHttp} className="space-y-4 bg-paper p-5 rounded-2xl border border-line">
              <div className="p-3 bg-warn-soft border border-line rounded-xl text-warn text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>
                  Для HTTP-01 проверки ваш домен должен быть уже направлен на IP сервера, а порт 80 должен быть открыт в фаерволе.
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Домен</label>
                  <input
                    type="text"
                    required
                    placeholder="panel.example.com"
                    value={httpDomain}
                    onChange={(e) => setHttpDomain(e.target.value)}
                    className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-mint"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Email</label>
                  <input
                    type="email"
                    required
                    placeholder="admin@example.com"
                    value={httpEmail}
                    onChange={(e) => setHttpEmail(e.target.value)}
                    className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-mint"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={httpIssuing || !httpDomain.trim()}
                className="flex items-center gap-2 bg-mint hover:bg-mint disabled:opacity-50 text-on-accent font-bold text-xs px-5 py-2.5 rounded-full transition btn-press hover:text-on-accent"
              >
                {httpIssuing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                <span>Выпустить сертификат (HTTP-01)</span>
              </button>
            </form>
          )}

          {/* Tab 4: Custom PEM */}
          {sslTab === 'custom' && (
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
                  className="w-full bg-paper border border-line rounded-xl px-3.5 py-2 text-ink text-xs focus:outline-none focus:border-mint"
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
                  className="w-full bg-paper border border-line rounded-xl p-3 text-ink text-[11px] font-mono focus:outline-none focus:border-mint"
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
                  className="w-full bg-paper border border-line rounded-xl p-3 text-ink text-[11px] font-mono focus:outline-none focus:border-mint"
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
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* SECTION 2: Fail2ban SSH Protection */}
      {/* ========================================================================= */}
      <div className="bg-card border border-line rounded-2xl p-6 sm:p-8 shadow-pop space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-line">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-info-soft border border-line flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-info" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink tracking-wide">Защита от перебора по SSH (Fail2ban)</h2>
              <p className="text-xs text-muted">
                Автоматическая блокировка злоумышленников и ботов при попытках подбора паролей к SSH
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
                f2bStatus?.active
                  ? 'bg-ok-soft text-ok border border-line'
                  : 'bg-soft text-muted border border-line'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
              {f2bStatus?.active ? 'Служба Fail2ban активна' : 'Не установлена / Не запущена'}
            </span>

            {!f2bStatus?.active && (
              <button
                onClick={handleSetupFail2ban}
                disabled={f2bSettingUp}
                className="flex items-center gap-1.5 bg-mint hover:bg-mint text-on-accent font-bold text-xs px-3.5 py-1.5 rounded-full transition btn-press hover:text-on-accent"
              >
                {f2bSettingUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                <span>Установить Fail2ban</span>
              </button>
            )}
          </div>
        </div>

        {/* Fail2ban Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 bg-paper border border-line rounded-2xl">
            <span className="text-xs text-faint">Неудачных попыток входа</span>
            <div className="text-2xl font-bold text-ink mt-1 font-mono">
              {f2bStatus?.totalFailed ?? 0}
            </div>
          </div>

          <div className="p-4 bg-paper border border-line rounded-2xl">
            <span className="text-xs text-faint">Всего заблокировано ботов</span>
            <div className="text-2xl font-bold text-info mt-1 font-mono">
              {f2bStatus?.totalBanned ?? 0}
            </div>
          </div>

          <div className="p-4 bg-paper border border-line rounded-2xl">
            <span className="text-xs text-faint">Активных банов (сейчас)</span>
            <div className="text-2xl font-bold text-ok mt-1 font-mono">
              {f2bStatus?.currentlyBanned?.length ?? 0}
            </div>
          </div>
        </div>

        {/* Currently Banned IPs Table */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink">
              Список заблокированных IP-адресов
            </h3>
            <button
              onClick={() => loadSecurityData()}
              className="text-xs text-muted hover:text-ink transition flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Обновить</span>
            </button>
          </div>

          {f2bStatus?.currentlyBanned && f2bStatus.currentlyBanned.length > 0 ? (
            <div className="border border-line rounded-2xl overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-paper text-muted">
                  <tr>
                    <th className="p-3 font-medium">Заблокированный IP адрес</th>
                    <th className="p-3 font-medium">Статус</th>
                    <th className="p-3 font-medium text-right">Действие</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-paper">
                  {f2bStatus.currentlyBanned.map((ip) => (
                    <tr key={ip} className="hover:bg-soft">
                      <td className="p-3 font-mono font-medium text-bad flex items-center gap-2">
                        <Ban className="w-3.5 h-3.5 text-bad" />
                        <span>{ip}</span>
                      </td>
                      <td className="p-3 text-muted">
                        Заблокирован (попытки перебора)
                      </td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => handleUnban(ip)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-soft hover:bg-soft-2 text-ink rounded-lg transition border border-line"
                        >
                          <Unlock className="w-3 h-3 text-ok" />
                          <span>Разблокировать</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-6 bg-paper border border-dashed border-line rounded-2xl text-center text-xs text-faint">
              В настоящее время нет заблокированных IP-адресов. Защита работает в штатном режиме.
            </div>
          )}
        </div>

        {/* Manual Ban Input */}
        <form onSubmit={handleManualBan} className="pt-2 flex items-center gap-3">
          <input
            type="text"
            placeholder="Заблокировать IP вручную (например: 1.2.3.4)..."
            value={manualBanIp}
            onChange={(e) => setManualBanIp(e.target.value)}
            className="flex-1 min-w-0 bg-paper border border-line rounded-xl px-3.5 py-2 text-xs text-ink font-mono focus:outline-none focus:border-mint"
          />
          <button
            type="submit"
            disabled={banning || !manualBanIp.trim()}
            className="flex items-center gap-1.5 bg-danger hover:bg-danger text-on-accent font-bold text-xs px-4 py-2 rounded-full transition disabled:opacity-50 btn-press hover:text-on-accent"
          >
            {banning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
            <span>Заблокировать</span>
          </button>
        </form>
      </div>

      {/* ========================================================================= */}
      {/* SECTION 3: Перенос панели на другой сервер */}
      {/* ========================================================================= */}
      <MigrationCard publicUrl={publicUrl} onStateChange={onMigrationChange} />
    </div>
  );
};
