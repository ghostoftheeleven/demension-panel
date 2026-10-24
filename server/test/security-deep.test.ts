import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { FailureLimiter } from '../src/middleware/rate-limit.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../src/services/secrets.service.js';
import { fingerprintHostKey, HostKeyMismatchError, SshService } from '../src/services/ssh.service.js';
import { allocateIp, formatEndpointHost, isValidHost, isValidPort, parseSubnet } from '../src/utils/net.js';

describe('Глубокое тестирование безопасности и утилит', () => {
  describe('FailureLimiter (защита от брутфорса)', () => {
    it('блокирует ключ после достижения порога и сообщает оставшееся время', () => {
      const limiter = new FailureLimiter(3, 10000); // 3 попытки, 10с
      const key = '192.0.2.1';

      expect(limiter.blockedFor(key)).toBe(0);
      limiter.registerFailure(key);
      expect(limiter.blockedFor(key)).toBe(0);
      limiter.registerFailure(key);
      expect(limiter.blockedFor(key)).toBe(0);

      // Третья неудача блокирует
      limiter.registerFailure(key);
      const blocked = limiter.blockedFor(key);
      expect(blocked).toBeGreaterThan(0);
      expect(blocked).toBeLessThanOrEqual(10000);

      // Сброс при успехе
      limiter.reset(key);
      expect(limiter.blockedFor(key)).toBe(0);
    });

    it('очищает истёкшие записи', () => {
      const limiter = new FailureLimiter(2, 50); // 50 мс окно
      limiter.registerFailure('test-ip');
      limiter.registerFailure('test-ip');
      expect(limiter.blockedFor('test-ip')).toBeGreaterThan(0);

      // Ждём истечения окна
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          limiter.cleanup();
          expect(limiter.blockedFor('test-ip')).toBe(0);
          resolve();
        }, 70);
      });
    });
  });

  describe('Секреты (AES-256-GCM)', () => {
    it('обрабатывает null, undefined и пустые строки', () => {
      expect(encryptSecret(null)).toBeNull();
      expect(encryptSecret(undefined)).toBeNull();
      expect(encryptSecret('')).toBeNull();
      expect(decryptSecret(null)).toBeNull();
      expect(decryptSecret(undefined)).toBeNull();
      expect(decryptSecret('')).toBeNull();
    });

    it('повторное шифрование идемпотентно', () => {
      const enc1 = encryptSecret('my-secret-key')!;
      expect(isEncrypted(enc1)).toBe(true);
      const enc2 = encryptSecret(enc1);
      expect(enc2).toBe(enc1);
    });

    it('декодирует устаревшие нешифрованные строки без падения', () => {
      expect(decryptSecret('legacy_plain_text')).toBe('legacy_plain_text');
    });

    it('обнаруживает повреждение шифротекста или тега аутентификации', () => {
      const original = encryptSecret('super-ssh-key-data')!;
      const raw = Buffer.from(original.slice('enc:v1:'.length), 'base64');

      // Повреждаем байт тега аутентификации (байты 12..28)
      raw[15] ^= 0xff;
      const corruptedTag = 'enc:v1:' + raw.toString('base64');
      expect(() => decryptSecret(corruptedTag)).toThrow();

      // Повреждаем байт зашифрованных данных (байты 28+)
      const raw2 = Buffer.from(original.slice('enc:v1:'.length), 'base64');
      raw2[raw2.length - 1] ^= 0xff;
      const corruptedCipher = 'enc:v1:' + raw2.toString('base64');
      expect(() => decryptSecret(corruptedCipher)).toThrow();
    });
  });

  describe('SSH TOFU и утилиты хоста', () => {
    it('fingerprintHostKey возвращает SHA256:... без паддинга =', () => {
      const fakeKey = crypto.randomBytes(32);
      const fp = fingerprintHostKey(fakeKey);
      expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
      expect(fp.endsWith('=')).toBe(false);
    });

    it('HostKeyMismatchError содержит понятное сообщение об атаке MITM', () => {
      const err = new HostKeyMismatchError('SHA256:expected', 'SHA256:actual');
      expect(err.expected).toBe('SHA256:expected');
      expect(err.actual).toBe('SHA256:actual');
      expect(err.message).toContain('человек посередине');
    });

    it('SshService.sudo выдаёт префикс sudo -n только для не-root пользователей', () => {
      expect(SshService.sudo({ host: '1.2.3.4', username: 'root' })).toBe('');
      expect(SshService.sudo({ host: '1.2.3.4' })).toBe('');
      expect(SshService.sudo({ host: '1.2.3.4', username: 'ubuntu' })).toBe('sudo -n ');
      expect(SshService.sudo({ host: '1.2.3.4', username: 'debian' })).toBe('sudo -n ');
    });
  });

  describe('Сетевые границы и валидация', () => {
    it('isValidPort проверяет диапазон 1-65535', () => {
      expect(isValidPort(22)).toBe(true);
      expect(isValidPort(51820)).toBe(true);
      expect(isValidPort(0)).toBe(false);
      expect(isValidPort(65536)).toBe(false);
      expect(isValidPort(-1)).toBe(false);
      expect(isValidPort(NaN)).toBe(false);
      expect(isValidPort(80)).toBe(true);
      expect(isValidPort('80')).toBe(false);
      expect(isValidPort('abc')).toBe(false);
    });

    it('isValidHost отклоняет инъекции и принимает валидные IP/домены', () => {
      expect(isValidHost('192.168.1.1')).toBe(true);
      expect(isValidHost('vpn.company.org')).toBe(true);
      expect(isValidHost('2001:4860:4860::8888')).toBe(true);
      expect(isValidHost('1.1.1.1; rm -rf /')).toBe(false);
      expect(isValidHost('`id`')).toBe(false);
      expect(isValidHost('host\nname')).toBe(false);
      expect(isValidHost('-bad-host')).toBe(false);
    });

    it('formatEndpointHost оборачивает только IPv6', () => {
      expect(formatEndpointHost('1.2.3.4')).toBe('1.2.3.4');
      expect(formatEndpointHost('vpn.example.com')).toBe('vpn.example.com');
      expect(formatEndpointHost('::1')).toBe('[::1]');
      expect(formatEndpointHost('2001:db8::1')).toBe('[2001:db8::1]');
      expect(formatEndpointHost('[2001:db8::1]')).toBe('[2001:db8::1]');
    });

    it('allocateIp в подсети /30 корректно отдаёт 2 хоста и бросает исключение на 3-м', () => {
      const subnet = '192.168.10.1/30';
      const ip1 = allocateIp(subnet, []);
      expect(ip1).toBe('192.168.10.2');

      // Для /30: .0 - сеть, .1 - сервер, .2 - клиент 1 -> свободных больше нет!
      expect(() => allocateIp(subnet, ['192.168.10.2'])).toThrow(/переполнена/);
    });
  });
});
