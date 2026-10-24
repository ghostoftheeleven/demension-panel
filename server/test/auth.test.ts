import { beforeAll, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';

beforeAll(() => {
  initDatabase();
});

describe('AuthService', () => {
  it('хэширует пароль и успешно проверяет его', () => {
    const { hash, salt } = AuthService.hashPassword('SuperSecret123!');
    expect(AuthService.verifyPassword('SuperSecret123!', hash, salt)).toBe(true);
    expect(AuthService.verifyPassword('WrongPassword!', hash, salt)).toBe(false);
  });

  it('создаёт дефолтного админа и позволяет войти', () => {
    AuthService.ensureDefaultAdmin('testadmin', 'SecretPass123!');
    const loginRes = AuthService.login('testadmin', 'SecretPass123!');
    expect(loginRes).not.toBeNull();
    expect(loginRes?.user.username).toBe('testadmin');
    expect(typeof loginRes?.token).toBe('string');

    // Проверка сессии
    const sessionUser = AuthService.validateSession(loginRes!.token);
    expect(sessionUser?.username).toBe('testadmin');

    // Логаут
    AuthService.logout(loginRes!.token);
    expect(AuthService.validateSession(loginRes!.token)).toBeNull();
  });

  it('отклоняет неверный логин или пароль', () => {
    expect(AuthService.login('nonexistent', 'anypass')).toBeNull();
    expect(AuthService.login('testadmin', 'wrongpass')).toBeNull();
  });

  it('смена пароля инвалидирует старые сессии и выдаёт новый токен', () => {
    AuthService.resetAdmin('admin_change', 'OldPass1234!');
    const firstLogin = AuthService.login('admin_change', 'OldPass1234!');
    expect(firstLogin).not.toBeNull();

    const newToken = AuthService.changePassword(firstLogin!.user.id, 'OldPass1234!', 'NewPass5678!');
    expect(newToken).not.toBeNull();

    // Старая сессия недействительна
    expect(AuthService.validateSession(firstLogin!.token)).toBeNull();
    // Новая сессия действительна
    expect(AuthService.validateSession(newToken!)).not.toBeNull();
  });
});

describe('случайные учётные данные администратора', () => {
  it('логин — буква и 9 символов a-z0-9, пароль — 20 символов A-Za-z0-9; значения не повторяются и не «admin»', () => {
    const logins = new Set<string>();
    const passwords = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const login = AuthService.randomLogin();
      const password = AuthService.randomPassword();
      expect(login).toMatch(/^[a-z][a-z0-9]{9}$/);
      expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
      logins.add(login);
      passwords.add(password);
    }
    expect(logins.size).toBe(2000);
    expect(passwords.size).toBe(2000);
    expect(logins.has('admin')).toBe(false);
  });

  it('символы распределены равномерно: встречаются заглавные, строчные и цифры', () => {
    const sample = Array.from({ length: 200 }, () => AuthService.randomPassword()).join('');
    expect(sample).toMatch(/[A-Z]/);
    expect(sample).toMatch(/[a-z]/);
    expect(sample).toMatch(/[0-9]/);
  });
});

describe('администратор при первом запуске без PANEL_USER и PANEL_PASSWORD', () => {
  it('получает случайные логин и пароль, которые выводятся в журнал один раз и подходят для входа', async () => {
    const { vi } = await import('vitest');
    db.exec('DELETE FROM sessions; DELETE FROM admins;');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    AuthService.ensureDefaultAdmin(undefined, undefined);

    const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
    const [, login, password] = /Логин: (\S+)\s+Пароль: (\S+)/.exec(printed)!;
    expect(login).toMatch(/^[a-z][a-z0-9]{9}$/);
    expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(AuthService.login(login, password)).not.toBeNull();
    expect(AuthService.login('admin', 'admin')).toBeNull();

    // Повторный запуск ничего не создаёт и не печатает
    log.mockClear();
    AuthService.ensureDefaultAdmin(undefined, undefined);
    expect(log).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS c FROM admins').get() as any).c).toBe(1);
    log.mockRestore();
  });
});
