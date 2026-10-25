import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AwgService } from '../src/services/awg.service.js';
import { PartnerService } from '../src/services/partner.service.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertServer } from './helpers/db.js';
import { stubSsh } from './helpers/ssh-stub.js';
import { startTestServer } from './test-app.js';

/**
 * Сторона владельца нод: изоляция партнёров друг от друга, лимиты, приостановка, проверка входных данных,
 * журнал действий и выдача токена.
 */

let env: Awaited<ReturnType<typeof startTestServer>>;
let admin: ReturnType<typeof createAdminApi>;
let nodeId: number;
let otherNodeId: number;

beforeAll(async () => {
  initDatabase();
  process.env.ALLOW_INSECURE_FEDERATION = '1';
  env = await startTestServer();
  admin = createAdminApi(env, 'admin_owner');
  nodeId = insertServer({ name: 'Нода владельца', subnet: '10.20.0.1/24' });
  otherNodeId = insertServer({ name: 'Закрытая нода', subnet: '10.21.0.1/24' });
});

afterAll(async () => {
  delete process.env.ALLOW_INSECURE_FEDERATION;
  await env.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function createPartner(extra: Record<string, unknown> = {}) {
  const res = await admin.api('/api/partners', 'POST', { name: `Партнёр ${Math.random().toString(36).slice(2, 7)}`, node_ids: [nodeId], ...extra });
  expect(res.status).toBe(201);
  const token = res.body.token as string;
  const fed = async (path: string, method = 'GET', body?: unknown) => {
    const response = await env.request(`/api/federation/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  return { id: res.body.partner.id as number, token, fed };
}

const newKey = () => AwgService.generateKeyPair().publicKey;

describe('изоляция партнёров', () => {
  it('партнёр видит и меняет только своих клиентов', async () => {
    stubSsh();
    const a = await createPartner();
    const b = await createPartner();
    const peerA = (await a.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'A1' })).body.peer;
    await b.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'B1' });

    expect((await a.fed('/peers')).body.peers.map((p: any) => p.name)).toEqual(['A1']);
    expect((await b.fed('/peers')).body.peers.map((p: any) => p.name)).toEqual(['B1']);

    // Чужой клиент: изменить, отключить, удалить нельзя — для партнёра его «нет»
    expect((await b.fed(`/peers/${peerA.id}`, 'PATCH', { name: 'hacked', enabled: false })).status).toBe(404);
    expect((await b.fed(`/peers/${peerA.id}`, 'DELETE')).status).toBe(404);
    expect(db.prepare('SELECT name, enabled FROM clients WHERE id = ?').get(peerA.id)).toEqual({ name: 'A1', enabled: 1 });
  });

  it('нода, не выданная партнёру, недоступна: создать на ней клиента нельзя', async () => {
    const partner = await createPartner();
    const res = await partner.fed('/peers', 'POST', { node_id: otherNodeId, public_key: newKey(), name: 'x' });
    expect(res.status).toBe(404);
    expect((await partner.fed('/nodes')).body.nodes.map((n: any) => n.id)).toEqual([nodeId]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM clients WHERE server_id = ?').get(otherNodeId)).toEqual({ c: 0 });
  });

  it('ответы не содержат секретов: ни приватных ключей клиентов, ни SSH, ни ключа сервера', async () => {
    stubSsh();
    const partner = await createPartner();
    const created = await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'safe' });
    const text = JSON.stringify([created.body, (await partner.fed('/nodes')).body, (await partner.fed('/peers')).body]);
    const row = db.prepare('SELECT server_private_key, ssh_password FROM servers WHERE id = ?').get(nodeId) as any;
    expect(text).not.toContain(row.server_private_key);
    expect(text).not.toMatch(/ssh_|private_key|client_private_key/);
    expect(Object.keys(created.body.peer).sort()).toEqual(
      ['client_ip', 'enabled', 'id', 'last_handshake', 'name', 'node_id', 'owner_blocked', 'preshared_key', 'public_key', 'remote_ref', 'total_rx', 'total_tx']
    );
  });
});

describe('проверка входных данных', () => {
  it.each([
    ['ключ не base64', { public_key: 'not-a-key' }],
    ['ключ не той длины', { public_key: 'AAAA=' }],
    ['ключ не строка', { public_key: 123 }],
    ['пустое имя', { name: '   ' }],
    ['имя не строка', { name: { a: 1 } }],
    ['слишком длинное имя', { name: 'x'.repeat(65) }],
    ['нода не число', { node_id: 'abc' }],
    ['нода отрицательная', { node_id: -5 }],
  ])('POST /peers отклоняет: %s', async (_name, patch) => {
    const partner = await createPartner();
    const res = await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'ok', ...patch });
    expect(res.status).toBe(400);
  });

  it('имя нормализуется: переводы строк заменяются пробелами, remote_ref обрезается до 64 символов', async () => {
    stubSsh();
    const partner = await createPartner();
    const res = await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: ' имя\nс\r\nпереводом ', remote_ref: 'r'.repeat(100) });
    expect(res.status).toBe(201);
    expect(res.body.peer.name).toBe('имя с  переводом');
    expect(res.body.peer.remote_ref).toHaveLength(64);
  });

  it('PATCH проверяет имя и принимает частичные изменения', async () => {
    stubSsh();
    const partner = await createPartner();
    const peer = (await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'P' })).body.peer;

    expect((await partner.fed(`/peers/${peer.id}`, 'PATCH', { name: '' })).status).toBe(400);
    expect((await partner.fed(`/peers/${peer.id}`, 'PATCH', { name: 'z'.repeat(65) })).status).toBe(400);
    expect((await partner.fed(`/peers/${peer.id}`, 'PATCH', {})).body.peer.name).toBe('P');
    const renamed = await partner.fed(`/peers/${peer.id}`, 'PATCH', { name: 'Новое' });
    expect(renamed.body.peer).toMatchObject({ name: 'Новое', enabled: true });
    expect((await partner.fed('/peers/abc', 'PATCH', {})).status).toBe(400);
  });

  it('повторный POST с тем же remote_ref идемпотентен и не занимает второй IP', async () => {
    stubSsh();
    const partner = await createPartner();
    const key = newKey();
    const first = await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: key, name: 'once', remote_ref: 'same' });
    const second = await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: key, name: 'once', remote_ref: 'same' });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.peer.id).toBe(first.body.peer.id);
    expect(second.body.peer.client_ip).toBe(first.body.peer.client_ip);
    expect((await partner.fed('/peers')).body.peers).toHaveLength(1);
  });

  it('нода без установки недоступна для создания клиентов', async () => {
    const fresh = insertServer({ status: 'uninstalled' });
    const partner = await createPartner({ node_ids: [fresh] });
    const res = await partner.fed('/peers', 'POST', { node_id: fresh, public_key: newKey(), name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('не установлена');
  });
});

describe('лимиты и приостановка', () => {
  it('исчерпание лимита трафика приостанавливает партнёра, клиенты снимаются с ноды, затем доступ возобновляется', async () => {
    const ssh = stubSsh();
    const partner = await createPartner({ traffic_limit: 1000 });
    const peer = (await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'traffic' })).body.peer;
    const activeOnNode = () => ProvisionService.getServerClients(nodeId).find((c) => c.id === peer.id).subscriber_active;
    expect(activeOnNode()).toBe(1);

    db.prepare('UPDATE clients SET total_rx = 600, total_tx = 500 WHERE id = ?').run(peer.id);
    PartnerService.refreshSuspension();

    expect(db.prepare('SELECT suspended FROM partners WHERE id = ?').get(partner.id)).toEqual({ suspended: 1 });
    expect(activeOnNode()).toBe(0);
    expect((await partner.fed('/info')).body.limits.suspended).toBe(true);
    const blocked = await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'late' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toContain('приостановлен');
    expect(ssh.calls.length).toBeGreaterThan(0); // синхронизация ноды после приостановки

    await admin.api(`/api/partners/${partner.id}`, 'PUT', { traffic_limit: 0 });
    expect(db.prepare('SELECT suspended FROM partners WHERE id = ?').get(partner.id)).toEqual({ suspended: 0 });
    expect(activeOnNode()).toBe(1);
    const actions = (await admin.api(`/api/partners/${partner.id}/audit`)).body.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['created', 'peer_created', 'suspended', 'resumed']));
  });

  it('истёкший срок приостанавливает партнёра', async () => {
    stubSsh();
    const partner = await createPartner({ expire_at: new Date(Date.now() + 3600_000).toISOString() });
    expect((await partner.fed('/info')).body.limits.suspended).toBe(false);

    db.prepare("UPDATE partners SET expire_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(partner.id);
    PartnerService.refreshSuspension();
    const info = await partner.fed('/info');
    expect(info.body.limits).toMatchObject({ suspended: true, expire_at: '2020-01-01T00:00:00.000Z' });
  });

  it('отключённого партнёра и перевыпущенный токен не пускают', async () => {
    stubSsh();
    const partner = await createPartner();
    expect((await partner.fed('/info')).status).toBe(200);

    const regenerated = await admin.api(`/api/partners/${partner.id}/regenerate-token`, 'POST');
    expect(regenerated.status).toBe(200);
    expect((await partner.fed('/info')).status).toBe(401);

    const fresh = await env.request('/api/federation/v1/info', { headers: { Authorization: `Bearer ${regenerated.body.token}` } });
    expect(fresh.status).toBe(200);
    await admin.api(`/api/partners/${partner.id}`, 'PUT', { enabled: false });
    const disabled = await env.request('/api/federation/v1/info', { headers: { Authorization: `Bearer ${regenerated.body.token}` } });
    expect(disabled.status).toBe(403);
  });

  it('отзыв ноды у партнёра снимает его клиентов с неё', async () => {
    stubSsh();
    const partner = await createPartner();
    const peer = (await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'revoked' })).body.peer;

    await admin.api(`/api/partners/${partner.id}`, 'PUT', { node_ids: [otherNodeId] });

    expect(ProvisionService.getServerClients(nodeId).find((c) => c.id === peer.id).subscriber_active).toBe(0);
    expect((await partner.fed('/nodes')).body.nodes.map((n: any) => n.id)).toEqual([otherNodeId]);
  });

  it('удаление партнёра удаляет его клиентов', async () => {
    stubSsh();
    const partner = await createPartner();
    const peer = (await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'gone' })).body.peer;
    expect((await admin.api(`/api/partners/${partner.id}`, 'DELETE')).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM clients WHERE id = ?').get(peer.id)).toEqual({ c: 0 });
    expect((await partner.fed('/info')).status).toBe(401);
  });

  it('владелец блокирует клиента партнёра, но не может удалить его', async () => {
    stubSsh();
    const partner = await createPartner();
    const peer = (await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'moderated' })).body.peer;

    const blocked = await admin.api(`/api/clients/${peer.id}`, 'PUT', { enabled: false });
    expect(blocked.body.owner_blocked).toBe(true);
    expect((await partner.fed('/peers')).body.peers[0].owner_blocked).toBe(true);
    expect((await admin.api(`/api/clients/${peer.id}`, 'DELETE')).status).toBe(409);
    expect((await admin.api(`/api/clients/${peer.id}/config`)).status).toBe(409);
    const actions = (await admin.api(`/api/partners/${partner.id}/audit`)).body.map((a: any) => a.action);
    expect(actions).toContain('owner_blocked');
  });
});

describe('журнал действий партнёра', () => {
  it('записывает создание, отключение, включение и удаление с IP партнёра', async () => {
    stubSsh();
    const partner = await createPartner();
    const peer = (await partner.fed('/peers', 'POST', { node_id: nodeId, public_key: newKey(), name: 'audited' })).body.peer;
    await partner.fed(`/peers/${peer.id}`, 'PATCH', { enabled: false });
    await partner.fed(`/peers/${peer.id}`, 'PATCH', { enabled: true });
    await partner.fed(`/peers/${peer.id}`, 'DELETE');

    const audit = (await admin.api(`/api/partners/${partner.id}/audit`)).body as any[];
    expect(audit.map((a) => a.action).reverse()).toEqual(['created', 'peer_created', 'peer_disabled', 'peer_enabled', 'peer_deleted']);
    expect(audit.find((a) => a.action === 'peer_created').ip).toBeTruthy();
    expect((await admin.api(`/api/partners/${partner.id}`)).status).toBeLessThan(500);
  });

  it('журнал ограничен последними 1000 записями', () => {
    const partnerId = Number(db.prepare("INSERT INTO partners (name, token_hash, token_hint) VALUES ('log', 'hash-log', 'h')").run().lastInsertRowid);
    for (let i = 0; i < 1005; i++) PartnerService.audit(partnerId, 'x', String(i), null);
    expect(db.prepare('SELECT COUNT(*) AS c FROM partner_audit WHERE partner_id = ?').get(partnerId)).toEqual({ c: 1000 });
    expect(db.prepare('SELECT MIN(details + 0) AS oldest FROM partner_audit WHERE partner_id = ?').get(partnerId)).toEqual({ oldest: 5 });
    // 1005 записей с отдельной фиксацией каждой — на Linux в Docker около 3,5 с при лимите vitest 5 с: без запаса тест случайно падал под нагрузкой
  }, 30000);
});

describe('управление партнёрами (админ-API)', () => {
  it('проверяет входные данные', async () => {
    for (const body of [
      { name: '' }, { name: 'x'.repeat(65) }, { name: 'ok', node_ids: 'x' }, { name: 'ok', node_ids: [999999] }, { name: 'ok', node_ids: [{}] },
      { name: 'ok', max_clients: -1 }, { name: 'ok', max_clients: 1.5 }, { name: 'ok', traffic_limit: 'много' }, { name: 'ok', expire_at: 'не дата' },
    ]) {
      expect((await admin.api('/api/partners', 'POST', body)).status).toBe(400);
    }
  });

  it('нельзя выдать партнёру чужую (партнёрскую) ноду', async () => {
    const panelId = Number(db.prepare("INSERT INTO remote_panels (name, base_url, token) VALUES ('r', 'https://r.example', 'x')").run().lastInsertRowid);
    const remote = insertServer({ name: 'Чужая' });
    db.prepare('UPDATE servers SET remote_panel_id = ?, remote_node_id = 5 WHERE id = ?').run(panelId, remote);
    const res = await admin.api('/api/partners', 'POST', { name: 'ok', node_ids: [remote] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('чужие');
  });

  it('токен показывается один раз: в БД и в списке только хэш и подсказка', async () => {
    const created = await admin.api('/api/partners', 'POST', { name: 'hash-only', node_ids: [nodeId] });
    const token = created.body.token as string;
    expect(created.body.connect_string).toContain(`#${token}`);

    const list = JSON.stringify((await admin.api('/api/partners')).body);
    expect(list).not.toContain(token);
    expect(list).not.toContain('token_hash');
    const stored = db.prepare('SELECT token_hash, token_hint FROM partners WHERE id = ?').get(created.body.partner.id) as any;
    expect(stored.token_hash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token.slice(10, 30));
  });

  it('публичный адрес из настроек используется в строке подключения', async () => {
    await admin.api('/api/settings', 'PUT', { public_url: 'https://panel.example.com/' });
    const created = await admin.api('/api/partners', 'POST', { name: 'public-url', node_ids: [nodeId] });
    expect(created.body.connect_string).toBe(`https://panel.example.com#${created.body.token}`);
    await admin.api('/api/settings', 'PUT', { public_url: '' });
  });
});

describe('ограничения частоты (последним: лимиты блокируют адрес тестов)', () => {
  it('300 запросов в минуту на партнёра, затем 429 с Retry-After', async () => {
    const partner = await createPartner();
    for (let i = 0; i < 299; i++) await partner.fed('/info');
    expect((await partner.fed('/info')).status).toBe(200);
    const limited = await partner.fed('/info');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('20 неверных токенов блокируют адрес даже для верного токена', async () => {
    const partner = await createPartner();
    // Неверные токены из предыдущих тестов этого файла тоже учтены, поэтому блокировка наступает не позже 20-й попытки
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await env.request('/api/federation/v1/info', { headers: { Authorization: 'Bearer dp_wrong' + i } });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    const blocked = await partner.fed('/info');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('неверных токенов');
  });
});
