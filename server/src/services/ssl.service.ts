import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { db } from '../db/index.js';
import * as acme from 'acme-client';
import { generate as generateSelfSigned } from 'selfsigned';

const sslDir = path.resolve(process.cwd(), 'data/ssl');
if (!fs.existsSync(sslDir)) {
  fs.mkdirSync(sslDir, { recursive: true });
}

export const certPath = path.join(sslDir, 'fullchain.pem');
export const keyPath = path.join(sslDir, 'privkey.pem');

// In-memory challenge store for HTTP-01
export const http01Challenges = new Map<string, string>();

export interface SslStatus {
  enabled: boolean;
  hasCert: boolean;
  domain: string | null;
  mode: string | null;
  expiresAt: string | null;
  certPath: string;
  keyPath: string;
}

export class SslService {
  /**
   * Get current SSL status and configuration
   */
  static getStatus(): SslStatus {
    const enabledRow = db.prepare("SELECT value FROM settings WHERE key = 'ssl_enabled'").get() as any;
    const modeRow = db.prepare("SELECT value FROM settings WHERE key = 'ssl_mode'").get() as any;
    const domainRow = db.prepare("SELECT value FROM settings WHERE key = 'ssl_domain'").get() as any;
    const expiresRow = db.prepare("SELECT value FROM settings WHERE key = 'ssl_expires_at'").get() as any;

    const hasCert = fs.existsSync(certPath) && fs.existsSync(keyPath);

    return {
      enabled: enabledRow?.value === '1',
      hasCert,
      domain: domainRow?.value || null,
      mode: modeRow?.value || null,
      expiresAt: expiresRow?.value || null,
      certPath,
      keyPath,
    };
  }

  /**
   * Verify Cloudflare API token
   */
  static async verifyCloudflareToken(token: string): Promise<{ valid: boolean; message: string }> {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await res.json() as any;
      if (data.success && data.result?.status === 'active') {
        return { valid: true, message: 'Токен Cloudflare успешно подтвержден!' };
      }
      return { valid: false, message: data.errors?.[0]?.message || 'Токен Cloudflare недействителен' };
    } catch (err: any) {
      return { valid: false, message: `Ошибка проверки токена: ${err.message}` };
    }
  }

  /**
   * Get list of Cloudflare zones accessible with this token
   */
  static async getCloudflareZones(token: string): Promise<{ id: string; name: string }[]> {
    const res = await fetch('https://api.cloudflare.com/client/v4/zones?status=active&per_page=50', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await res.json() as any;
    if (!data.success) {
      throw new Error(data.errors?.[0]?.message || 'Не удалось получить список зон Cloudflare');
    }
    return (data.result || []).map((z: any) => ({ id: z.id, name: z.name }));
  }

  /**
   * Automatically issue Let's Encrypt certificate using Cloudflare DNS-01 API
   */
  static async issueLetsEncryptCloudflare(
    domain: string,
    email: string,
    cfToken: string,
    createARecord = true
  ): Promise<{ success: boolean; error?: string }> {
    const cleanDomain = domain.trim().toLowerCase();
    const cleanEmail = email.trim();

    // 1. Find matching Cloudflare Zone
    const zones = await this.getCloudflareZones(cfToken);
    const matchedZone = zones.find((z) => cleanDomain === z.name || cleanDomain.endsWith('.' + z.name));

    if (!matchedZone) {
      throw new Error(
        `Зона для домена ${cleanDomain} не найдена в вашем аккаунте Cloudflare. Убедитесь, что домен добавлен в Cloudflare.`
      );
    }

    // 2. Optional: Automatically add/update DNS A-record to this server's public IP
    if (createARecord) {
      try {
        const publicIpRes = await fetch('https://api.ipify.org?format=json');
        const { ip } = await publicIpRes.json() as any;
        if (ip) {
          // Check if A record already exists
          const existingRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${matchedZone.id}/dns_records?type=A&name=${cleanDomain}`,
            { headers: { Authorization: `Bearer ${cfToken}` } }
          );
          const existingData = await existingRes.json() as any;

          if (existingData.result && existingData.result.length > 0) {
            const recordId = existingData.result[0].id;
            await fetch(
              `https://api.cloudflare.com/client/v4/zones/${matchedZone.id}/dns_records/${recordId}`,
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${cfToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  type: 'A',
                  name: cleanDomain,
                  content: ip,
                  proxied: false,
                  ttl: 120,
                }),
              }
            );
          } else {
            await fetch(
              `https://api.cloudflare.com/client/v4/zones/${matchedZone.id}/dns_records`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${cfToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  type: 'A',
                  name: cleanDomain,
                  content: ip,
                  proxied: false,
                  ttl: 120,
                }),
              }
            );
          }
        }
      } catch (e) {
        console.warn('Не удалось автоматически создать A-запись в Cloudflare (продолжаем DNS-01 challenge):', e);
      }
    }

    // 3. Request ACME certificate via DNS-01
    const client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt.production,
      accountKey: await acme.crypto.createPrivateKey(),
    });

    const [key, csr] = await acme.crypto.createCsr({
      commonName: cleanDomain,
    });

    const createdRecordIds = new Map<string, string>();

    const cert = await client.auto({
      csr,
      email: cleanEmail,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (challenge.type === 'dns-01') {
          const recordName = `_acme-challenge.${authz.identifier.value}`;

          const cfRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${matchedZone.id}/dns_records`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${cfToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                type: 'TXT',
                name: recordName,
                content: keyAuthorization,
                ttl: 120,
              }),
            }
          );
          const cfData = await cfRes.json() as any;
          if (cfData.success && cfData.result?.id) {
            createdRecordIds.set(challenge.token, cfData.result.id);
          }

          // Wait 12 seconds for DNS propagation across Cloudflare authoritative servers
          await new Promise((r) => setTimeout(r, 12000));
        }
      },
      challengeRemoveFn: async (authz, challenge) => {
        if (challenge.type === 'dns-01') {
          const recId = createdRecordIds.get(challenge.token);
          if (recId) {
            await fetch(
              `https://api.cloudflare.com/client/v4/zones/${matchedZone.id}/dns_records/${recId}`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${cfToken}` },
              }
            ).catch(() => {});
          }
        }
      },
    });

    // 4. Save certificate files
    fs.writeFileSync(certPath, cert);
    fs.writeFileSync(keyPath, key);

    // Calculate expiry (usually 90 days from now)
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_enabled', '1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_mode', 'letsencrypt_cf')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_domain', ?)").run(cleanDomain);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_expires_at', ?)").run(expiresAt);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf_token', ?)").run(cfToken);

    return { success: true };
  }

  /**
   * Issue Let's Encrypt certificate using HTTP-01 challenge (requires port 80 open)
   */
  static async issueLetsEncryptHttp(domain: string, email: string): Promise<{ success: boolean; error?: string }> {
    const cleanDomain = domain.trim().toLowerCase();
    const cleanEmail = email.trim();

    const client = new acme.Client({
      directoryUrl: acme.directory.letsencrypt.production,
      accountKey: await acme.crypto.createPrivateKey(),
    });

    const [key, csr] = await acme.crypto.createCsr({
      commonName: cleanDomain,
    });

    const cert = await client.auto({
      csr,
      email: cleanEmail,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (authz, challenge, keyAuthorization) => {
        if (challenge.type === 'http-01') {
          http01Challenges.set(challenge.token, keyAuthorization);
        }
      },
      challengeRemoveFn: async (authz, challenge) => {
        if (challenge.type === 'http-01') {
          http01Challenges.delete(challenge.token);
        }
      },
    });

    fs.writeFileSync(certPath, cert);
    fs.writeFileSync(keyPath, key);

    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_enabled', '1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_mode', 'letsencrypt_http')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_domain', ?)").run(cleanDomain);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_expires_at', ?)").run(expiresAt);

    return { success: true };
  }

  /**
   * Generate self-signed certificate with IP SAN (Subject Alternative Name) for accessing panel by IP
   */
  static async generateSelfSignedIpCert(ipOrDomain: string): Promise<{ success: boolean; error?: string }> {
    const target = ipOrDomain.trim();

    const notAfterDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    const pems = await generateSelfSigned([{ name: 'commonName', value: target }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 7, ip: target },
            { type: 2, value: target },
          ],
        },
      ],
    });

    fs.writeFileSync(certPath, pems.cert);
    fs.writeFileSync(keyPath, pems.private);

    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_enabled', '1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_mode', 'selfsigned_ip')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_domain', ?)").run(target);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_expires_at', ?)").run(expiresAt);

    return { success: true };
  }

  /**
   * Save existing / custom certificate from uploaded strings or paths
   */
  static saveCustomCertificate(certContent: string, keyContent: string, domain = 'custom'): void {
    if (!certContent.includes('BEGIN CERTIFICATE') || !keyContent.includes('BEGIN')) {
      throw new Error('Некорректный формат сертификата или ключа (ожидается PEM-формат)');
    }

    fs.writeFileSync(certPath, certContent.trim());
    fs.writeFileSync(keyPath, keyContent.trim());

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_enabled', '1')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_mode', 'custom')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_domain', ?)").run(domain);
  }

  /**
   * Toggle SSL on/off
   */
  static toggleSsl(enabled: boolean): void {
    if (enabled && (!fs.existsSync(certPath) || !fs.existsSync(keyPath))) {
      throw new Error('Сертификаты не найдены. Сначала выпустите или загрузите сертификат.');
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ssl_enabled', ?)").run(enabled ? '1' : '0');
  }
}
