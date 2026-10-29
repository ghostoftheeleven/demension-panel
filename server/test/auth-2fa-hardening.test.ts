import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { loginIpLimiter, loginUserLimiter, reauthLimiter } from '../src/middleware/rate-limit.js';
import { startTestServer } from './test-app.js';

const USER = 'twofa_hardening';
const PASSWORD = 'TestPassword123!';

describe('2FA: перебор и повтор кода, IP сессий', () => {
  let env: Awaited<ReturnType<typeof startTestServer>>;
  let adminId: number;
  let secretBuf: Buffer;

  const login = async (body: Record<string, unknown>) => {
    const res = await env.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASSWORD, ...body }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const resetLimiters = () => {
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) loginIpLimiter.reset(ip);
    loginUserLimiter.reset(USER);
    reauthLimiter.reset(`admin:login:${USER}`);
  };

  beforeAll(async () => {
    initDatabase();
    env = await startTestServer();
    AuthService.resetAdmin(USER, PASSWORD);
    adminId = (db.prepare('SELECT id FROM admins WHERE username = ?').get(USER) as { id: number }).id;
    const { secret } = AuthService.generateTotpSecret(USER);
    secretBuf = AuthService.base32Decode(secret);
    AuthService.enableTotp(adminId, secret, AuthService.generateTotp(secretBuf));
  });

  afterAll(async () => {
    await env.close();
  });

  it('один и тот же TOTP-код второй раз не принимается', () => {
    const step = Math.floor(Date.now() / 1000 / 30);
    const code = AuthService.generateTotp(secretBuf, step);
    expect(AuthService.loginWithTotp(USER, PASSWORD, code)).toHaveProperty('token');
    expect(AuthService.loginWithTotp(USER, PASSWORD, code)).toBe('invalid_code');
    // предыдущий шаг тоже уже «в прошлом» относительно принятого
    expect(AuthService.loginWithTotp(USER, PASSWORD, AuthService.generateTotp(secretBuf, step - 1))).toBe('invalid_code');
  });

  it('5 неверных кодов блокируют ввод кода даже верным, но не вход без кода', async () => {
    resetLimiters();
    for (let i = 0; i < 5; i++) expect((await login({ totp: '000000' })).status).toBe(401);
    // лимит по IP/логину отдельный: снимаем его, чтобы проверить именно блокировку кода
    loginIpLimiter.reset('127.0.0.1');
    loginUserLimiter.reset(USER);
    const code = AuthService.generateTotp(secretBuf, Math.floor(Date.now() / 1000 / 30) + 1);
    const blocked = await login({ totp: code });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('неверных кодов');
    resetLimiters();
  });

  it('неверный пароль с произвольным кодом не блокирует код администратора', async () => {
    resetLimiters();
    for (let i = 0; i < 5; i++) expect((await login({ password: 'wrong-password', totp: '000000' })).status).toBe(401);
    loginIpLimiter.reset('127.0.0.1');
    loginUserLimiter.reset(USER);
    expect(reauthLimiter.blockedFor(`admin:login:${USER}`)).toBe(0);
    resetLimiters();
  });

  it('сессия после смены пароля сохраняет IP и User-Agent', () => {
    const token = AuthService.changePassword(adminId, PASSWORD, PASSWORD, '203.0.113.9', 'Test Browser');
    expect(token).toBeTruthy();
    const session = db.prepare('SELECT ip, user_agent FROM sessions WHERE admin_id = ? ORDER BY id DESC LIMIT 1').get(adminId) as any;
    expect(session).toEqual({ ip: '203.0.113.9', user_agent: 'Test Browser' });
  });
});
