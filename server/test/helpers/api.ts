import { AuthService } from '../../src/services/auth.service.js';
import { startTestServer } from '../test-app.js';

export type TestEnv = Awaited<ReturnType<typeof startTestServer>>;

/**
 * Клиент API тестового приложения от имени администратора: возвращает статус и разобранное тело.
 * Каждый тестовый файл использует собственную БД, поэтому логин администратора задаётся в файле.
 */
export function createAdminApi(env: TestEnv, username: string, password = 'TestPassword123!') {
  AuthService.resetAdmin(username, password);
  const token = AuthService.login(username, password)!.token;
  const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra });

  async function api(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) {
    const res = await env.request(path, {
      method,
      headers: headers(extraHeaders),
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  return { api, token, headers };
}
