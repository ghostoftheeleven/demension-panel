import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetting, initDatabase, setSetting } from '../src/db/index.js';
import { SslService, certPath, keyPath } from '../src/services/ssl.service.js';
import { generate } from 'selfsigned';

/**
 * Управление сертификатами без обращения к сети: самоподписанные и загруженные сертификаты, проверки при сохранении,
 * включение HTTPS, условия продления и разбор ответов Cloudflare.
 */

beforeAll(() => {
  initDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const x509 = () => new crypto.X509Certificate(fs.readFileSync(certPath));

async function makeCert(commonName: string, options: Record<string, unknown> = {}) {
  return generate([{ name: 'commonName', value: commonName }], { keySize: 2048, algorithm: 'sha256', ...options });
}

describe('самоподписанный сертификат', () => {
  it('для IP — IP SAN без DNS SAN; сертификат включён и действует около года', async () => {
    const result = await SslService.generateSelfSignedIpCert('203.0.113.9');
    expect(result).toEqual({ success: true });

    const san = x509().subjectAltName ?? '';
    expect(san).toContain('IP Address:203.0.113.9');
    expect(san).not.toContain('DNS:');
    expect(SslService.getStatus()).toMatchObject({ enabled: true, hasCert: true, domain: '203.0.113.9', mode: 'selfsigned_ip', autoRenew: false });
    const days = (new Date(SslService.getStatus().expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(366);
    expect(SslService.isActive()).toBe(true);
  }, 30000);

  it('для домена — DNS SAN без IP SAN', async () => {
    await SslService.generateSelfSignedIpCert('panel.example.com');
    const san = x509().subjectAltName ?? '';
    expect(san).toContain('DNS:panel.example.com');
    expect(san).not.toContain('IP Address');
    expect(SslService.getStatus().domain).toBe('panel.example.com');
  }, 30000);

  it('закрытый ключ хранится с правами 600 (на POSIX), ключ подходит к сертификату', async () => {
    await SslService.generateSelfSignedIpCert('127.0.0.1');
    if (process.platform !== 'win32') expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(x509().checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(keyPath)))).toBe(true);
  }, 30000);

  it.each(['', '   ', 'not a domain', 'bad_domain.example.com', '-start.example.com', 'a'.repeat(300) + '.com', 'host;id'])(
    'некорректная цель %j отклоняется до выпуска',
    async (target) => {
      await expect(SslService.generateSelfSignedIpCert(target)).rejects.toThrow('корректное доменное имя');
    }
  );
});

describe('загруженный сертификат', () => {
  it('принимается, если ключ подходит и срок не истёк; домен берётся из аргумента или из CN', async () => {
    const pems = await makeCert('custom.example.com');
    SslService.saveCustomCertificate(pems.cert, pems.private, ' my.example.org ');
    expect(SslService.getStatus()).toMatchObject({ mode: 'custom', domain: 'my.example.org', autoRenew: false, enabled: true });

    SslService.saveCustomCertificate(pems.cert, pems.private);
    expect(SslService.getStatus().domain).toBe('custom.example.com');
    expect(fs.readFileSync(certPath, 'utf-8')).toContain('BEGIN CERTIFICATE');
  }, 30000);

  it('не принимает сертификат с чужим ключом и не затирает рабочий сертификат', async () => {
    const good = await makeCert('good.example.com');
    const other = await makeCert('other.example.com');
    SslService.saveCustomCertificate(good.cert, good.private);
    const before = fs.readFileSync(certPath, 'utf-8');

    expect(() => SslService.saveCustomCertificate(good.cert, other.private)).toThrow('не соответствует');
    expect(fs.readFileSync(certPath, 'utf-8')).toBe(before);
    expect(SslService.getStatus().domain).toBe('good.example.com');
  }, 30000);

  it('не принимает истёкший сертификат', async () => {
    const expired = await makeCert('old.example.com', {
      notBeforeDate: new Date(Date.now() - 400 * 86_400_000),
      notAfterDate: new Date(Date.now() - 30 * 86_400_000),
    });
    expect(() => SslService.saveCustomCertificate(expired.cert, expired.private)).toThrow('истёк');
  }, 30000);

  it.each([
    ['не PEM', 'мусор', 'мусор'],
    ['пустые строки', '', ''],
  ])('не принимает: %s', (_name, cert, key) => {
    expect(() => SslService.saveCustomCertificate(cert, key)).toThrow('Некорректный формат');
  });

  it('не принимает значения не строкового типа', () => {
    expect(() => SslService.saveCustomCertificate({} as any, 5 as any)).toThrow('строками');
  });

  it('сертификат без CN получает имя из SAN (современный Let\'s Encrypt)', async () => {
    const sanOnly = await generate([{ name: 'organizationName', value: 'No CN Org' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'san-only.example.com' }, { type: 2, value: 'www.san-only.example.com' }] }],
    });
    expect(x509Of(sanOnly.cert).subject).not.toContain('CN=');
    SslService.saveCustomCertificate(sanOnly.cert, sanOnly.private);
    expect(SslService.getStatus().domain).toBe('san-only.example.com');

    // Если CN есть, он по-прежнему главнее SAN
    const withCn = await makeCert('cn.example.com', {
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'other-name.example.com' }] }],
    });
    SslService.saveCustomCertificate(withCn.cert, withCn.private);
    expect(SslService.getStatus().domain).toBe('cn.example.com');
  }, 30000);
});

const x509Of = (pem: string) => new crypto.X509Certificate(pem);

describe('перенос панели: сертификат, приехавший вместе с данными', () => {
  it('activateExisting включает HTTPS на лежащем в data/ssl сертификате и сохраняет режим выпуска, домен и почту (автопродление работает)', async () => {
    await SslService.generateSelfSignedIpCert('203.0.113.20');
    setSetting('ssl_mode', 'letsencrypt_cf');
    setSetting('ssl_email', 'admin@example.com');
    SslService.toggleSsl(false);
    setSetting('ssl_expires_at', '2000-01-01T00:00:00.000Z');
    const listener = vi.fn();
    SslService.onCertificateChanged(listener);

    const result = SslService.activateExisting();
    expect(result.domain).toBe('203.0.113.20');
    expect(SslService.getStatus()).toMatchObject({ enabled: true, mode: 'letsencrypt_cf', domain: '203.0.113.20', autoRenew: true });
    // Дата окончания перечитана из самого сертификата, а не взята из прежних настроек
    expect(new Date(SslService.getStatus().expiresAt!).getFullYear()).toBeGreaterThan(2000);
    expect(getSetting('ssl_email')).toBe('admin@example.com');
    expect(listener).toHaveBeenCalled();
  }, 30000);

  it('activateExisting отказывает без сертификата, с истёкшим сертификатом и с ключом от другого', async () => {
    SslService.clearCertificate();
    expect(() => SslService.activateExisting()).toThrow('не найден');

    const expired = await makeCert('old.example.com', {
      notBeforeDate: new Date(Date.now() - 400 * 86_400_000),
      notAfterDate: new Date(Date.now() - 30 * 86_400_000),
    });
    fs.writeFileSync(certPath, expired.cert);
    fs.writeFileSync(keyPath, expired.private);
    expect(() => SslService.activateExisting()).toThrow('истёк');

    const other = await makeCert('other.example.com');
    fs.writeFileSync(certPath, other.cert);
    fs.writeFileSync(keyPath, expired.private);
    expect(() => SslService.activateExisting()).toThrow('не соответствует');
    SslService.clearCertificate();
  }, 60000);

  it('clearCertificate удаляет файлы и отключает HTTPS, но оставляет токен Cloudflare и почту для следующего выпуска', async () => {
    await SslService.generateSelfSignedIpCert('203.0.113.21');
    setSetting('ssl_email', 'admin@example.com');
    setSetting('cf_token', 'enc:v1:stub');
    SslService.clearCertificate();

    expect(SslService.hasCertificate()).toBe(false);
    expect(SslService.getStatus()).toMatchObject({ enabled: false, hasCert: false, domain: null, mode: null, expiresAt: null });
    expect(getSetting('ssl_email')).toBe('admin@example.com');
    expect(getSetting('cf_token')).toBe('enc:v1:stub');
    setSetting('cf_token', null);
  }, 30000);

  it('getSavedCloudflareToken расшифровывает сохранённый токен; повреждённое значение даёт null, а не исключение', async () => {
    const { encryptSecret } = await import('../src/services/secrets.service.js');
    setSetting('cf_token', encryptSecret('cf-saved-token'));
    expect(SslService.getSavedCloudflareToken()).toBe('cf-saved-token');
    setSetting('cf_token', 'enc:v1:AAAA');
    expect(SslService.getSavedCloudflareToken()).toBeNull();
    setSetting('cf_token', null);
    expect(SslService.getSavedCloudflareToken()).toBeNull();
  });
});

describe('включение HTTPS и уведомления об изменении сертификата', () => {
  it('toggleSsl переключает флаг и уведомляет подписчиков', async () => {
    await SslService.generateSelfSignedIpCert('127.0.0.1');
    const listener = vi.fn();
    SslService.onCertificateChanged(listener);

    SslService.toggleSsl(false);
    expect(SslService.isActive()).toBe(false);
    expect(SslService.getStatus()).toMatchObject({ enabled: false, hasCert: true });
    SslService.toggleSsl(true);
    expect(SslService.isActive()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);

    await SslService.generateSelfSignedIpCert('127.0.0.2');
    expect(listener).toHaveBeenCalledTimes(3);
  }, 30000);

  it('без сертификата включить HTTPS нельзя', () => {
    const backup = fs.readFileSync(certPath);
    fs.rmSync(certPath);
    try {
      expect(() => SslService.toggleSsl(true)).toThrow('Сертификаты не найдены');
      expect(SslService.hasCertificate()).toBe(false);
    } finally {
      fs.writeFileSync(certPath, backup);
    }
  });

  it('ошибка подписчика не мешает остальным', async () => {
    const failing = vi.fn(() => {
      throw new Error('listener failed');
    });
    const healthy = vi.fn();
    SslService.onCertificateChanged(failing);
    SslService.onCertificateChanged(healthy);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await SslService.generateSelfSignedIpCert('127.0.0.3');

    expect(failing).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalled();
  }, 30000);
});

describe('продление сертификата Let\'s Encrypt', () => {
  const setLetsEncrypt = (mode: string, expiresInDays: number, email: string | null) => {
    setSetting('ssl_mode', mode);
    setSetting('ssl_domain', 'renew.example.com');
    setSetting('ssl_expires_at', new Date(Date.now() + expiresInDays * 86_400_000).toISOString());
    setSetting('ssl_email', email);
  };

  it('не делает ничего для самоподписанных и загруженных сертификатов и пока срок больше 30 дней', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setLetsEncrypt('selfsigned_ip', 1, 'a@b.co');
    await SslService.renewIfNeeded();
    setLetsEncrypt('custom', 1, 'a@b.co');
    await SslService.renewIfNeeded();
    setLetsEncrypt('letsencrypt_http', 60, 'a@b.co');
    await SslService.renewIfNeeded();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('без сохранённого email продление невозможно — предупреждение, без обращения к ACME', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLetsEncrypt('letsencrypt_http', 5, null);
    await SslService.renewIfNeeded();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('не сохранён email'));
  });

  it('при ошибке продления только пишет в журнал и не бросает исключение', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setLetsEncrypt('letsencrypt_cf', 5, 'a@b.co');
    setSetting('cf_token', null);
    await expect(SslService.renewIfNeeded()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('не сохранён токен Cloudflare'));
  });
});

describe('выпуск через Let\'s Encrypt: проверка данных до обращения к сети', () => {
  it('HTTP-01 проверяет домен и email', async () => {
    await expect(SslService.issueLetsEncryptHttp('bad domain', 'a@b.co')).rejects.toThrow('корректное доменное имя');
    await expect(SslService.issueLetsEncryptHttp('ok.example.com', 'не email')).rejects.toThrow('корректный email');
  });

  it('Cloudflare DNS-01: домена нет в аккаунте — понятная ошибка, токен не сохраняется', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ success: true, result: [{ id: 'z1', name: 'other.org' }, { id: 'z2', name: 'example.org' }] }));
    }));

    await expect(SslService.issueLetsEncryptCloudflare('vpn.example.com', 'a@b.co', 'cf-token', false)).rejects.toThrow('Зона для домена vpn.example.com не найдена');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/zones?status=active');
    expect(getSetting('cf_token')).toBeNull();
  });
});

describe('Cloudflare API', () => {
  it('verifyCloudflareToken различает активный, отозванный токен и сетевую ошибку', async () => {
    const stub = (payload: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload))));

    stub({ success: true, result: { status: 'active' } });
    expect(await SslService.verifyCloudflareToken('t')).toEqual({ valid: true, message: expect.stringContaining('подтвержден') });

    stub({ success: false, errors: [{ message: 'Invalid API Token' }] });
    expect(await SslService.verifyCloudflareToken('t')).toEqual({ valid: false, message: 'Invalid API Token' });

    stub({ success: true, result: { status: 'disabled' } });
    expect((await SslService.verifyCloudflareToken('t')).valid).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }));
    expect(await SslService.verifyCloudflareToken('t')).toEqual({ valid: false, message: expect.stringContaining('ENOTFOUND') });
  });

  it('getCloudflareZones возвращает id и имена или ошибку API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, result: [{ id: 'a', name: 'example.com', extra: 1 }] }))));
    expect(await SslService.getCloudflareZones('t')).toEqual([{ id: 'a', name: 'example.com' }]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'Forbidden' }] }))));
    await expect(SslService.getCloudflareZones('t')).rejects.toThrow('Forbidden');
  });

  it('токен передаётся только в заголовке Authorization', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] })));
    vi.stubGlobal('fetch', spy);
    await SslService.getCloudflareZones('secret-cf-token');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-cf-token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-cf-token');
  });
});
