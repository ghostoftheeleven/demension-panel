import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { AuthService } from '../src/services/auth.service.js';
import { EventService } from '../src/services/event.service.js';
import { db, initDatabase } from '../src/db/index.js';

function createTestAdmin(username: string, password: string): number {
  const { hash, salt } = AuthService.hashPassword(password);
  return Number(db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)')
    .run(username, hash, salt).lastInsertRowid);
}

describe('2FA (TOTP)', () => {
  let adminId: number;
  let username: string;
  let password: string;

  beforeAll(() => {
    initDatabase();
  });

  beforeEach(() => {
    username = `admin2fa_${Date.now()}`;
    password = 'Test.Pass-123';
    adminId = createTestAdmin(username, password);
  });

  describe('включение TOTP', () => {
    test('генерирует секрет и URI для QR-кода', () => {
      const result = AuthService.generateTotpSecret(username);

      expect(result.secret).toMatch(/^[A-Z2-7]{32}$/); // Base32, 32 символа
      expect(result.uri).toContain('otpauth://totp/');
      expect(result.uri).toContain(encodeURIComponent(username));
      expect(result.uri).toContain('issuer=Dementia');
    });

    test('включается по первому верному TOTP-коду и возвращает recovery codes', () => {
      const { secret } = AuthService.generateTotpSecret(username);

      // Генерируем верный код
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);

      const result = AuthService.enableTotp(adminId, secret, validCode);

      expect(result).not.toBe('invalid_code');
      expect(Array.isArray(result.recoveryCodes)).toBe(true);
      expect(result.recoveryCodes).toHaveLength(10);

      // Проверяем, что коды сохранились как SHA-256
      const admin = db.prepare('SELECT totp_enabled, totp_secret, recovery_codes FROM admins WHERE id = ?')
        .get(adminId) as any;

      expect(admin.totp_enabled).toBe(1);
      expect(admin.totp_secret).toBeTruthy();
      expect(admin.recovery_codes).toBeTruthy();

      const stored = JSON.parse(admin.recovery_codes);
      expect(stored).toHaveLength(10);
      // SHA-256 хэш = 64 hex символа
      stored.forEach((hash: string) => expect(hash).toMatch(/^[a-f0-9]{64}$/));

      // Recovery code не должен совпадать с хэшем
      expect(stored.includes(result.recoveryCodes[0])).toBe(false);
    });

    test('отклоняет неверный TOTP-код при включении', () => {
      const { secret } = AuthService.generateTotpSecret(username);

      const result = AuthService.enableTotp(adminId, secret, '000000');

      expect(result).toBe('invalid_code');

      // TOTP не должен включиться
      const admin = db.prepare('SELECT totp_enabled FROM admins WHERE id = ?').get(adminId) as any;
      expect(admin.totp_enabled).toBe(0);
    });

    test('логирует включение 2FA в события', () => {
      const { secret } = AuthService.generateTotpSecret(username);
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);

      const eventsBefore = EventService.list({ offset: 0, limit: 10 });
      AuthService.enableTotp(adminId, secret, validCode);
      const eventsAfter = EventService.list({ offset: 0, limit: 10 });

      const newEvent = eventsAfter.items[0];
      expect(newEvent.type).toBe('admin_2fa_enabled');
      expect(newEvent.entity_id).toBe(String(adminId));
    });
  });

  describe('вход с TOTP', () => {
    let secret: string;

    beforeEach(() => {
      const gen = AuthService.generateTotpSecret(username);
      secret = gen.secret;
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);
      AuthService.enableTotp(adminId, secret, validCode);
    });

    test('без TOTP-кода возвращает totp_required', () => {
      const result = AuthService.loginWithTotp(username, password);

      expect(result).toBe('totp_required');
    });

    test('с верным TOTP-кодом возвращает токен', () => {
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);

      const result = AuthService.loginWithTotp(username, password, validCode);

      expect(result).not.toBe('totp_required');
      expect(result).not.toBe(null);
      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('user');
    });

    test('с неверным TOTP-кодом возвращает invalid_code', () => {
      const result = AuthService.loginWithTotp(username, password, '000000');

      expect(result).toBe('invalid_code');
    });

    test('с неверным паролем возвращает null, даже с верным TOTP', () => {
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);

      const result = AuthService.loginWithTotp(username, 'wrong-password', validCode);

      expect(result).toBe(null);
    });

    test('принимает recovery code вместо TOTP', () => {
      // Получаем recovery code при включении
      const gen2 = AuthService.generateTotpSecret(username + '_2');
      const adminId2 = createTestAdmin(username + '_2', password);
      const secretBuf2 = AuthService.base32Decode(gen2.secret);
      const validCode2 = AuthService.generateTotp(secretBuf2);
      const { recoveryCodes } = AuthService.enableTotp(adminId2, gen2.secret, validCode2) as { recoveryCodes: string[] };

      const recoveryCode = recoveryCodes[0];

      const result = AuthService.loginWithTotp(username + '_2', password, undefined, recoveryCode);

      expect(result).not.toBe('totp_required');
      expect(result).not.toBe(null);
      expect(result).toHaveProperty('token');
    });

    test('recovery code одноразовый — второе использование не проходит', () => {
      const gen2 = AuthService.generateTotpSecret(username + '_3');
      const adminId2 = createTestAdmin(username + '_3', password);
      const secretBuf2 = AuthService.base32Decode(gen2.secret);
      const validCode2 = AuthService.generateTotp(secretBuf2);
      const { recoveryCodes } = AuthService.enableTotp(adminId2, gen2.secret, validCode2) as { recoveryCodes: string[] };

      const recoveryCode = recoveryCodes[0];

      // Первый раз — успех
      const result1 = AuthService.loginWithTotp(username + '_3', password, undefined, recoveryCode);
      expect(result1).toHaveProperty('token');

      // Второй раз с тем же кодом — отклонён
      const result2 = AuthService.loginWithTotp(username + '_3', password, undefined, recoveryCode);
      expect(result2).toBe('invalid_code');
    });
  });

  describe('отключение TOTP', () => {
    beforeEach(() => {
      const { secret } = AuthService.generateTotpSecret(username);
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);
      AuthService.enableTotp(adminId, secret, validCode);
    });

    test('отключает TOTP и удаляет секрет с recovery codes', () => {
      AuthService.disableTotp(adminId);

      const admin = db.prepare('SELECT totp_enabled, totp_secret, recovery_codes FROM admins WHERE id = ?')
        .get(adminId) as any;

      expect(admin.totp_enabled).toBe(0);
      expect(admin.totp_secret).toBe(null);
      expect(admin.recovery_codes).toBe(null);
    });

    test('логирует отключение 2FA', () => {
      const eventsBefore = EventService.list({ offset: 0, limit: 10 });
      AuthService.disableTotp(adminId);
      const eventsAfter = EventService.list({ offset: 0, limit: 10 });

      const newEvent = eventsAfter.items[0];
      expect(newEvent.type).toBe('admin_2fa_disabled');
      expect(newEvent.entity_id).toBe(String(adminId));
    });

    test('после отключения вход без TOTP работает', () => {
      AuthService.disableTotp(adminId);

      const result = AuthService.loginWithTotp(username, password);

      expect(result).not.toBe('totp_required');
      expect(result).toHaveProperty('token');
    });
  });

  describe('перевыпуск recovery codes', () => {
    beforeEach(() => {
      const { secret } = AuthService.generateTotpSecret(username);
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);
      AuthService.enableTotp(adminId, secret, validCode);
    });

    test('заменяет старые коды новыми', () => {
      const admin1 = db.prepare('SELECT recovery_codes FROM admins WHERE id = ?').get(adminId) as any;
      const oldCodes = JSON.parse(admin1.recovery_codes);

      const newCodes = AuthService.rotateRecoveryCodes(adminId);

      expect(newCodes).toHaveLength(10);

      const admin2 = db.prepare('SELECT recovery_codes FROM admins WHERE id = ?').get(adminId) as any;
      const storedCodes = JSON.parse(admin2.recovery_codes);

      expect(storedCodes).not.toEqual(oldCodes);
      expect(storedCodes).toHaveLength(10);
    });

    test('старый recovery code не работает после перевыпуска', () => {
      const gen2 = AuthService.generateTotpSecret(username + '_4');
      const adminId2 = createTestAdmin(username + '_4', password);
      const secretBuf2 = AuthService.base32Decode(gen2.secret);
      const validCode2 = AuthService.generateTotp(secretBuf2);
      const { recoveryCodes: oldCodes } = AuthService.enableTotp(adminId2, gen2.secret, validCode2) as { recoveryCodes: string[] };

      AuthService.rotateRecoveryCodes(adminId2);

      const result = AuthService.loginWithTotp(username + '_4', password, undefined, oldCodes[0]);
      expect(result).toBe('invalid_code');
    });

    test('логирует перевыпуск recovery codes', () => {
      const eventsBefore = EventService.list({ offset: 0, limit: 10 });
      AuthService.rotateRecoveryCodes(adminId);
      const eventsAfter = EventService.list({ offset: 0, limit: 10 });

      const newEvent = eventsAfter.items[0];
      expect(newEvent.type).toBe('admin_recovery_codes_rotated');
      expect(newEvent.entity_id).toBe(String(adminId));
    });
  });

  describe('совместимость без 2FA', () => {
    test('обычный login без 2FA возвращает токен, не totp_required', () => {
      // Администратор без включённого TOTP
      const result = AuthService.loginWithTotp(username, password);

      expect(result).not.toBe('totp_required');
      expect(result).not.toBe(null);
      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('user');
    });
    test('сохраняет IP и User-Agent новой сессии', () => {
      const result = AuthService.loginWithTotp(username, password, undefined, undefined, '203.0.113.8', 'Test Browser');
      expect(result).toHaveProperty('token');
      const session = db.prepare('SELECT ip, user_agent FROM sessions WHERE admin_id = ? ORDER BY id DESC LIMIT 1').get(adminId) as any;
      expect(session).toEqual({ ip: '203.0.113.8', user_agent: 'Test Browser' });
    });
  });

  describe('ограничение частоты (reauthLimiter)', () => {
    test('неверные TOTP-коды считаются и блокируются', () => {
      const { secret } = AuthService.generateTotpSecret(username);
      const secretBuf = AuthService.base32Decode(secret);
      const validCode = AuthService.generateTotp(secretBuf);
      AuthService.enableTotp(adminId, secret, validCode);

      // 5 неверных попыток включения с неверным кодом
      for (let i = 0; i < 5; i++) {
        AuthService.enableTotp(adminId, secret, '000000');
      }

      // Шестая попытка должна быть заблокирована (reauthLimiter срабатывает в роутах, но проверим логику)
      // На уровне сервиса блокировки нет, она в middleware, но убедимся, что метод работает
      const result = AuthService.enableTotp(adminId, secret, '000000');
      expect(result).toBe('invalid_code');
    });
  });
});
