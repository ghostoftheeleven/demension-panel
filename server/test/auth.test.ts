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
