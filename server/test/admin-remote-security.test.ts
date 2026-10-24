import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AwgService } from '../src/services/awg.service.js';
import { FederationClient, parseConnectString } from '../src/services/federation-client.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient } from './helpers/db.js';
import { newRemote, stubRemotePanel } from './helpers/remote-panel.js';
import { startTestServer } from './test-app.js';

/**
 * Админ-API подключённых панелей партнёров (сторона получателя) и раздел «Безопасность» (HTTPS, Cloudflare, Fail2ban).
 */

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'admin_remote');
});

afterAll(async () => {
  await env.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.ALLOW_INSECURE_FEDERATION;
});

let counter = 0;
const connectString = (host = `owner-${++counter}.example.com`, token = `dp_${'k'.repeat(32)}`) => `https://${host}#${token}`;

describe('строка подключения', () => {
  it('разбирает адрес и токен, убирает слэши в конце пути', () => {
    expect(parseConnectString(`https://panel.example.com:8443/base///#dp_${'a'.repeat(24)}`)).toEqual({
      baseUrl: 'https://panel.example.com:8443/base',
      token: `dp_${'a'.repeat(24)}`,
    });
  });

  it.each([
    ['без токена', 'https://panel.example.com'],
    ['токен без префикса', `https://panel.example.com#${'a'.repeat(40)}`],
    ['слишком короткий токен', 'https://panel.example.com#dp_short'],
    ['токен с лишними символами', `https://panel.example.com#dp_${'a'.repeat(30)}!?`],
    ['не ссылка', `не ссылка#dp_${'a'.repeat(30)}`],
    ['обычный HTTP', `http://panel.example.com#dp_${'a'.repeat(30)}`],
    ['другая схема', `ftp://panel.example.com#dp_${'a'.repeat(30)}`],
    ['пустая строка', ''],
  ])('отклоняет: %s', (_name, input) => {
    expect(() => parseConnectString(input)).toThrow();
  });

  it('HTTP допускается только при ALLOW_INSECURE_FEDERATION=1 (для разработки)', () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';
    expect(parseConnectString(`http://localhost:3001#dp_${'a'.repeat(30)}`).baseUrl).toBe('http://localhost:3001');
  });
});

describe('подключение панели партнёра', () => {
  it('создаёт панель и ноды, токен хранится зашифрованным и не возвращается в API', async () => {
    const remote = newRemote();
    stubRemotePanel(remote, env.baseUrl);
    const res = await admin.api('/api/remote-panels', 'POST', { connect_string: connectString(), name: '  Партнёр Альфа  ' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Партнёр Альфа', partner_name: 'Owner', status: 'online', node_count: 1, client_count: 0, last_error: null });
    expect(JSON.stringify(res.body)).not.toContain('"token"');
    expect(JSON.stringify((await admin.api('/api/remote-panels')).body)).not.toContain('"token"');
    expect(db.prepare('SELECT token FROM remote_panels WHERE id = ?').get(res.body.id)).toEqual({ token: expect.stringMatching(/^enc:v1:/) });
    expect(remote.calls.every((c) => c.path === '/info' || c.path === '/nodes' || c.path === '/peers')).toBe(true);
  });

  it('имя по умолчанию — адрес панели; повторное подключение той же панели — 409', async () => {
    stubRemotePanel(newRemote(), env.baseUrl);
    const host = `unique-${++counter}.example.com`;
    const first = await admin.api('/api/remote-panels', 'POST', { connect_string: connectString(host) });
    expect(first.body.name).toBe(host);
    const again = await admin.api('/api/remote-panels', 'POST', { connect_string: connectString(host) });
    expect(again.status).toBe(409);
  });

  it('некорректные строки подключения — 400', async () => {
    for (const body of [{}, { connect_string: 123 }, { connect_string: 'https://x.example.com' }, { connect_string: connectString().replace('https', 'http') }]) {
      expect((await admin.api('/api/remote-panels', 'POST', body)).status).toBe(400);
    }
  });

  it('неверный или отозванный токен — 400, недоступная панель — 502', async () => {
    stubRemotePanel(newRemote({ failWith: 401 }), env.baseUrl);
    const denied = await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() });
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain('simulated 401');

    vi.unstubAllGlobals();
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith(env.baseUrl)) return realFetch(url, init);
      throw Object.assign(new Error('fetch failed'), { cause: { message: 'getaddrinfo ENOTFOUND' } });
    }));
    const unreachable = await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error).toContain('ENOTFOUND');
    expect(db.prepare("SELECT COUNT(*) AS c FROM remote_panels WHERE base_url LIKE '%owner-%' AND status = 'pending'").get()).toEqual({ c: 0 });
  });

  it('слишком длинное и пустое название при переименовании — 400', async () => {
    stubRemotePanel(newRemote(), env.baseUrl);
    const id = (await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() })).body.id;
    expect((await admin.api(`/api/remote-panels/${id}`, 'PATCH', { name: '  ' })).status).toBe(400);
    expect((await admin.api(`/api/remote-panels/${id}`, 'PATCH', { name: 'x'.repeat(65) })).status).toBe(400);
    expect((await admin.api(`/api/remote-panels/${id}`, 'PATCH', { name: ' Новое имя ' })).body.name).toBe('Новое имя');
    expect((await admin.api('/api/remote-panels/999999', 'PATCH', { name: 'x' })).status).toBe(404);
    expect((await admin.api('/api/remote-panels/999999/sync', 'POST')).status).toBe(404);
  });
});

describe('жизненный цикл панели партнёра', () => {
  it('отозванный доступ помечает панель revoked и убирает ноды из подписок, возвращение доступа восстанавливает их', async () => {
    const remote = newRemote();
    stubRemotePanel(remote, env.baseUrl);
    const id = (await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() })).body.id;
    const serverId = (db.prepare('SELECT id FROM servers WHERE remote_panel_id = ?').get(id) as any).id;

    remote.failWith = 403;
    const revoked = await admin.api(`/api/remote-panels/${id}/sync`, 'POST');
    expect(revoked.body).toMatchObject({ status: 'revoked', last_error: expect.stringContaining('403') });
    expect(db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId)).toEqual({ status: 'uninstalled' });

    remote.failWith = undefined;
    expect((await admin.api(`/api/remote-panels/${id}/sync`, 'POST')).body).toMatchObject({ status: 'online', last_error: null });
    expect(db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId)).toEqual({ status: 'online' });
  });

  it('временная ошибка сети переводит панель в error, не трогая ноды', async () => {
    const remote = newRemote();
    stubRemotePanel(remote, env.baseUrl);
    const id = (await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() })).body.id;

    remote.failWith = 500;
    expect((await admin.api(`/api/remote-panels/${id}/sync`, 'POST')).body.status).toBe('error');
    expect(db.prepare('SELECT status FROM servers WHERE remote_panel_id = ?').get(id)).toEqual({ status: 'online' });
  });

  it('нода, которую владелец перестал предоставлять, становится недоступной, а её клиенты сохраняются', async () => {
    const remote = newRemote();
    stubRemotePanel(remote, env.baseUrl);
    const id = (await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() })).body.id;
    const serverId = (db.prepare('SELECT id FROM servers WHERE remote_panel_id = ?').get(id) as any).id;
    const client = insertClient(serverId, { ip: 'pending:x' });

    // Владелец отдаёт другую ноду (id 8), прежней (id 7) в списке больше нет
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = String(url).split('/api/federation/v1')[1];
      const json = path === '/nodes'
        ? { nodes: [], limits: null }
        : { peers: [] };
      return new Response(JSON.stringify(json));
    }));
    await FederationClient.requestSync(id);

    expect(db.prepare('SELECT status, last_error FROM servers WHERE id = ?').get(serverId)).toEqual({
      status: 'uninstalled', last_error: expect.stringContaining('больше не предоставляется'),
    });
    expect(db.prepare('SELECT COUNT(*) AS c FROM clients WHERE id = ?').get(client.id)).toEqual({ c: 1 });
  });

  it('отключение панели удаляет клиентов у владельца, ноды и клиентов локально', async () => {
    const remote = newRemote();
    stubRemotePanel(remote, env.baseUrl);
    const id = (await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() })).body.id;
    const serverId = (db.prepare('SELECT id FROM servers WHERE remote_panel_id = ?').get(id) as any).id;
    const sub = await admin.api('/api/subscribers', 'POST', { name: 'ForDisconnect', server_ids: [serverId] });
    expect(remote.peers.size).toBe(1);

    const res = await admin.api(`/api/remote-panels/${id}`, 'DELETE');

    expect(res.body).toEqual({ success: true, remoteCleanup: true });
    expect(remote.peers.size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM servers WHERE remote_panel_id = ?').get(id)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM clients WHERE subscriber_id = ?').get(sub.body.id)).toEqual({ c: 0 });
    expect((await admin.api('/api/subscribers')).body.find((s: any) => s.id === sub.body.id)).toMatchObject({ peer_count: 0 });
  });

  it('если владелец недоступен, панель всё равно отключается, но remoteCleanup = false', async () => {
    const remote = newRemote();
    stubRemotePanel(remote, env.baseUrl);
    const id = (await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() })).body.id;
    remote.failWith = 500;
    expect((await admin.api(`/api/remote-panels/${id}`, 'DELETE')).body).toEqual({ success: true, remoteCleanup: false });
    expect((await admin.api('/api/remote-panels')).body.some((p: any) => p.id === id)).toBe(false);
    expect((await admin.api(`/api/remote-panels/${id}`, 'DELETE')).status).toBe(404);
  });

  it('ноды партнёра нельзя настраивать локально, но можно выдавать пользователям', async () => {
    const remote = newRemote();
    stubRemotePanel(remote, env.baseUrl);
    const id = (await admin.api('/api/remote-panels', 'POST', { connect_string: connectString() })).body.id;
    const serverId = (db.prepare('SELECT id FROM servers WHERE remote_panel_id = ?').get(id) as any).id;

    for (const [method, path, body] of [
      ['PUT', `/api/servers/${serverId}`, { name: 'x' }],
      ['DELETE', `/api/servers/${serverId}`, undefined],
      ['POST', `/api/servers/${serverId}/test-ssh`, undefined],
      ['POST', `/api/servers/${serverId}/scan`, undefined],
      ['POST', `/api/servers/${serverId}/apply`, undefined],
      ['POST', `/api/servers/${serverId}/randomize-params`, undefined],
      ['POST', `/api/servers/${serverId}/upgrade-protocol`, undefined],
    ] as [string, string, unknown][]) {
      const res = await admin.api(path, method, body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.body.error).toContain('нода партнёра');
    }

    const client = await admin.api(`/api/servers/${serverId}/clients`, 'POST', { name: 'на ноде партнёра' });
    expect(client.status).toBe(201);
    expect(client.body).toMatchObject({ pending: false, client_ip: expect.stringMatching(/^10\.50\.0\./) });
    expect((await admin.api(`/api/clients/${client.body.id}/qrcode`)).body.config).toContain('PresharedKey = ');
    expect(AwgService.validateParams((await admin.api(`/api/servers/${serverId}`)).body)).toBeNull();
  });
});

describe('раздел «Безопасность»', () => {
  it('статус сертификата по умолчанию и выпуск самоподписанного сертификата', async () => {
    expect((await admin.api('/api/security/ssl')).body).toMatchObject({ enabled: false, hasCert: false, domain: null, mode: null });

    const issued = await admin.api('/api/security/ssl/issue-ip', 'POST', { ip: '127.0.0.1' });
    expect(issued.body).toEqual({ success: true });
    expect((await admin.api('/api/security/ssl')).body).toMatchObject({ enabled: true, hasCert: true, domain: '127.0.0.1', mode: 'selfsigned_ip' });

    expect((await admin.api('/api/security/ssl/toggle', 'POST', { enabled: false })).body).toEqual({ success: true, enabled: false });
    expect((await admin.api('/api/security/ssl')).body.enabled).toBe(false);
  }, 30000);

  it('ошибки валидации отдаются как 400 с понятным текстом', async () => {
    const cases: [string, unknown][] = [
      ['/api/security/ssl/issue-ip', {}],
      ['/api/security/ssl/issue-ip', { ip: 'bad host!' }],
      ['/api/security/ssl/custom', {}],
      ['/api/security/ssl/custom', { cert: 'x', key: 'y' }],
      ['/api/security/ssl/issue-http', {}],
      ['/api/security/ssl/issue-http', { domain: 'bad domain', email: 'a@b.co' }],
      ['/api/security/ssl/issue-http', { domain: 'ok.example.com', email: 'не email' }],
      ['/api/security/ssl/issue-cf', { domain: 'ok.example.com', email: 'a@b.co' }],
      ['/api/security/ssl/verify-cf', {}],
      ['/api/security/ssl/cf-zones', { token: '   ' }],
    ];
    for (const [path, body] of cases) {
      const res = await admin.api(path, 'POST', body);
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
  });

  it('токен Cloudflare проверяется через API Cloudflare и не попадает в ответ', async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith(env.baseUrl)) return realFetch(url, init);
      return new Response(JSON.stringify({ success: true, result: { status: 'active' } }));
    }));
    const res = await admin.api('/api/security/ssl/verify-cf', 'POST', { token: 'cf-secret-token' });
    expect(res.body.valid).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('cf-secret-token');
  });

  it('Fail2ban: IP проверяется до вызова утилиты', async () => {
    for (const ip of ['1.1.1.1; id', '$(id)', '1.1.1', '', 123, null, { a: 1 }, '1.1.1.1\n2.2.2.2']) {
      for (const action of ['ban', 'unban']) {
        const res = await admin.api(`/api/security/fail2ban/${action}`, 'POST', { ip });
        expect(res.status, `${action} ${JSON.stringify(ip)}`).toBe(400);
        expect(res.body.error).toContain('IP');
      }
    }
  });

  it('статус Fail2ban не падает, если утилиты нет', async () => {
    const res = await admin.api('/api/security/fail2ban');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jail: 'sshd', currentlyBanned: expect.any(Array) });
  });
});
