import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSetting, initDatabase, setSetting } from '../src/db/index.js';
import {
  countryFlag,
  parsePingResult,
  parseTcpResult,
  probeStatus,
  ProbeService,
} from '../src/services/probe.service.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { startTestServer, type TestEnv } from './test-app.js';

/**
 * Проверка доступности нод из выбранных стран через check-host.net. Сеть не используется: fetch подменён,
 * ответы провайдера задаёт сценарий `provider`.
 */

const REAL_FETCH = globalThis.fetch;

const PING_OK = [[['OK', 0.045, '203.0.113.9'], ['OK', 0.05], ['OK', 0.04], ['OK', 0.05]]];
const PING_TIMEOUT = [[['TIMEOUT', 3.0], ['TIMEOUT', 3.0], ['TIMEOUT', 3.0], ['TIMEOUT', 3.0]]];

const provider = {
  nodes: {} as Record<string, [string, string, string]>,
  /** Ответы узлов по идентификатору; ключ отсутствует — узел «ещё считает» */
  ping: {} as Record<string, unknown>,
  tcp: {} as Record<string, unknown>,
  calls: [] as { path: string; host?: string; nodes?: string[] }[],
  failNodesList: false,
  startReply: null as unknown,
  /** Сколько первых опросов результата узлы отвечают null (ещё считают) */
  pendingPolls: 0,
};

function resetProvider() {
  provider.nodes = {
    'ru1.node.check-host.net': ['ru', 'Russia', 'Moscow'],
    'ru2.node.check-host.net': ['ru', 'Russia', 'Saint Petersburg'],
    'ru3.node.check-host.net': ['ru', 'Russia', 'Novosibirsk'],
    'kz1.node.check-host.net': ['kz', 'Kazakhstan', 'Karaganda'],
    'de1.node.check-host.net': ['de', 'Germany', 'Nuremberg'],
  };
  provider.ping = {
    'ru1.node.check-host.net': PING_OK,
    'ru2.node.check-host.net': PING_TIMEOUT,
    'kz1.node.check-host.net': PING_TIMEOUT,
    'de1.node.check-host.net': PING_OK,
  };
  provider.tcp = {
    'ru1.node.check-host.net': [{ time: 0.031, address: '203.0.113.9' }],
    'ru2.node.check-host.net': [{ time: 0.044, address: '203.0.113.9' }],
    'kz1.node.check-host.net': [{ error: 'Connection timed out' }],
    'de1.node.check-host.net': [{ time: 0.02, address: '203.0.113.9' }],
  };
  provider.calls = [];
  provider.failNodesList = false;
  provider.startReply = null;
  provider.pendingPolls = 0;
}

let env: TestEnv;
let api: ReturnType<typeof createAdminApi>['api'];
let serverId: number;
let subToken: string;
let polls = 0;

function installProviderStub() {
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== 'https://check-host.net') return REAL_FETCH(input, init);

    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/nodes/hosts') {
      provider.calls.push({ path: url.pathname });
      if (provider.failNodesList) return new Response('upstream down', { status: 503 });
      return json({ nodes: Object.fromEntries(Object.entries(provider.nodes).map(([id, location]) => [id, { asn: 'AS1', ip: '192.0.2.1', location }])) });
    }
    const start = /^\/check-(ping|tcp)$/.exec(url.pathname);
    if (start) {
      const nodes = url.searchParams.getAll('node');
      provider.calls.push({ path: url.pathname, host: url.searchParams.get('host') ?? undefined, nodes });
      polls = 0;
      if (provider.startReply) return json(provider.startReply);
      return json({
        ok: 1,
        request_id: start[1] === 'ping' ? 'pingreq1' : 'tcpreq1',
        nodes: Object.fromEntries(nodes.map((id) => [id, [...(provider.nodes[id] ?? ['xx']), '198.51.100.1', 'AS2']])),
      });
    }
    const result = /^\/check-result\/(pingreq1|tcpreq1)$/.exec(url.pathname);
    if (result) {
      polls++;
      const source = result[1] === 'pingreq1' ? provider.ping : provider.tcp;
      const pending = polls <= provider.pendingPolls;
      return json(Object.fromEntries(Object.keys(provider.nodes).map((id) => [id, pending ? null : source[id] ?? null])));
    }
    return new Response('not found', { status: 404 });
  });
}

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  ({ api } = createAdminApi(env, 'probeadmin', 'ProbeAdminPass-1'));
  ProbeService.pollDelayMs = 0;
  ProbeService.pollTotalMs = 150;
  serverId = insertServer({ name: 'Frankfurt', host: '203.0.113.9' });
  const subscriberId = insertSubscriber({ name: 'dave' });
  insertClient(serverId, { name: 'dave-phone', subscriberId });
  subToken = (db.prepare('SELECT token FROM subscribers WHERE id = ?').get(subscriberId) as any).token;
});

beforeEach(() => {
  resetProvider();
  installProviderStub();
  ProbeService.resetCountriesCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  ProbeService.pollDelayMs = null;
  await env.close();
});

const decodeLinks = (body: string) =>
  Buffer.from(body, 'base64')
    .toString()
    .split('\n')
    .map((line) => decodeURIComponent(line.split('#')[1] ?? ''));

const decodeHeader = (value: string | null) => Buffer.from((value ?? '').replace(/^base64:/, ''), 'base64').toString();

describe('разбор ответов check-host.net', () => {
  it('ping: успех, если хотя бы один пакет дошёл; задержка — среднее по успешным в мс', () => {
    expect(parsePingResult(PING_OK)).toEqual({ ok: true, rtt: 46 });
    expect(parsePingResult(PING_TIMEOUT)).toEqual({ ok: false, rtt: null });
    expect(parsePingResult([[['TIMEOUT', 3], ['OK', 0.1, '1.1.1.1'], ['MALFORMED', 0.2]]])).toEqual({ ok: true, rtt: 100 });
  });

  it('ping: пока узел считает (null) или не разрешил имя ([[null]]) — результата нет', () => {
    expect(parsePingResult(null)).toBeNull();
    expect(parsePingResult([[null]])).toBeNull();
    expect(parsePingResult('garbage')).toBeNull();
    expect(parsePingResult([[['OK', 'не число']]])).toEqual({ ok: false, rtt: null });
  });

  it('tcp: объект со временем — успех, с error — отказ, прочее — нет результата', () => {
    expect(parseTcpResult([{ time: 0.031, address: '1.2.3.4' }])).toEqual({ ok: true, rtt: 31 });
    expect(parseTcpResult([{ error: 'Connection timed out' }])).toEqual({ ok: false, rtt: null });
    expect(parseTcpResult(null)).toBeNull();
    expect(parseTcpResult([{}])).toBeNull();
  });

  it('статус страны и флаг', () => {
    expect(probeStatus(2, 2)).toBe('ok');
    expect(probeStatus(1, 2)).toBe('partial');
    expect(probeStatus(0, 2)).toBe('fail');
    expect(probeStatus(1, 1)).toBe('ok');
    expect(countryFlag('ru')).toBe('🇷🇺');
    expect(countryFlag('KZ')).toBe('🇰🇿');
  });
});

describe('настройки и страны', () => {
  it('по умолчанию проверка выключена, результатов нет, адреса нод никуда не отправляются', async () => {
    const res = await api('/api/probes');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ enabled: false, countries: [], interval_minutes: 30, show_in_name: true, show_in_description: true });
    expect(res.body.results).toEqual([]);
    expect(res.body.servers).toEqual([expect.objectContaining({ id: serverId, host: '203.0.113.9', probe_port: null })]);
    expect(provider.calls).toEqual([]);

    expect((await api('/api/servers')).body[0].probes).toEqual([]);
    expect((await env.request('/api/probes')).status).toBe(401);
  });

  it('список стран берётся у провайдера, группируется по странам и кэшируется', async () => {
    const first = await api('/api/probes/countries');
    expect(first.status).toBe(200);
    expect(first.body).toEqual([
      { code: 'de', name: 'Germany', nodes: ['de1.node.check-host.net'], cities: ['Nuremberg'] },
      { code: 'kz', name: 'Kazakhstan', nodes: ['kz1.node.check-host.net'], cities: ['Karaganda'] },
      { code: 'ru', name: 'Russia', nodes: ['ru1.node.check-host.net', 'ru2.node.check-host.net', 'ru3.node.check-host.net'], cities: ['Moscow', 'Saint Petersburg', 'Novosibirsk'] },
    ]);
    await api('/api/probes/countries');
    expect(provider.calls.filter((c) => c.path === '/nodes/hosts')).toHaveLength(1);
  });

  it('недоступность провайдера — 502 с понятным текстом; чужие идентификаторы узлов игнорируются', async () => {
    provider.failNodesList = true;
    const down = await api('/api/probes/countries');
    expect(down.status).toBe(502);
    expect(down.body.error).toContain('check-host.net');

    provider.failNodesList = false;
    provider.nodes['evil.example.com'] = ['ru', 'Russia', 'X'];
    provider.nodes['ru9.node.check-host.net'] = ['<script>', 'Bad', 'X'] as any;
    ProbeService.resetCountriesCache();
    const list = (await api('/api/probes/countries')).body as any[];
    expect(list.flatMap((c) => c.nodes)).not.toContain('evil.example.com');
    expect(list.map((c) => c.code)).toEqual(['de', 'kz', 'ru']);
  });

  it('валидация настроек: страна — двухбуквенный код, не более 8, интервал 10–1440, включение требует стран', async () => {
    expect((await api('/api/probes', 'PUT', { settings: { enabled: true } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: ['russia'] } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: ['ru; DROP'] } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: 'ru' } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { countries: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii'] } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { interval_minutes: 5 } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { settings: { interval_minutes: 2000 } })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { servers: [{ id: serverId, probe_port: 70000 }] })).status).toBe(400);
    expect((await api('/api/probes', 'PUT', { servers: [{ id: 99999, probe_port: 22 }] })).status).toBe(404);
    expect(ProbeService.readSettings().enabled).toBe(false);
  });

  it('настройки сохраняются: коды приводятся к нижнему регистру, дубли убираются', async () => {
    const res = await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['RU', 'kz', 'ru'], interval_minutes: 15, show_in_description: false } });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ enabled: true, countries: ['ru', 'kz'], interval_minutes: 15, show_in_name: true, show_in_description: false });
    expect(getSetting('probe_countries')).toBe('["ru","kz"]');
  });
});

describe('проверка нод', () => {
  beforeAll(async () => {
    await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['ru', 'kz'], interval_minutes: 30, show_in_description: true } });
  });

  it('ping из каждой страны: результаты по странам (все/часть/ни одного узла), в порядке выбора', async () => {
    const result = await ProbeService.runAll();
    expect(result).toEqual({ checked: 1, errors: [] });

    // Запрос к провайдеру: адрес ноды и по два узла от каждой страны (ru3 не берётся)
    const start = provider.calls.find((c) => c.path === '/check-ping')!;
    expect(start.host).toBe('203.0.113.9');
    expect(start.nodes).toEqual(['ru1.node.check-host.net', 'ru2.node.check-host.net', 'kz1.node.check-host.net']);

    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes).toEqual([
      expect.objectContaining({ country: 'ru', ok_nodes: 1, total_nodes: 2, status: 'partial', rtt_ms: 46 }),
      expect.objectContaining({ country: 'kz', ok_nodes: 0, total_nodes: 1, status: 'fail', rtt_ms: null }),
    ]);
    expect(getSetting('probe_last_run')).toBeTruthy();
    expect(getSetting('probe_error')).toBeNull();
    expect((await api('/api/probes')).body.status.running).toBe(false);
  });

  it('узлы, ещё не закончившие проверку, опрашиваются повторно', async () => {
    provider.pendingPolls = 2;
    provider.ping['kz1.node.check-host.net'] = PING_OK;
    expect(await ProbeService.runAll()).toEqual({ checked: 1, errors: [] });
    expect(polls).toBe(3);
    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes.find((p: any) => p.country === 'kz')).toMatchObject({ ok_nodes: 1, total_nodes: 1, status: 'ok' });
  });

  it('узел без ответа в итог не входит; если не ответил никто — прежний результат остаётся', async () => {
    delete provider.ping['ru2.node.check-host.net'];
    delete provider.ping['kz1.node.check-host.net'];
    await ProbeService.runAll();
    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes.find((p: any) => p.country === 'ru')).toMatchObject({ ok_nodes: 1, total_nodes: 1, status: 'ok' });
    // kz не ответил совсем — осталась запись предыдущей проверки
    expect(probes.find((p: any) => p.country === 'kz')).toMatchObject({ status: 'ok' });
  });

  it('TCP-режим: для сервера с портом проверяется подключение host:port (IPv6 — в скобках)', async () => {
    expect((await api('/api/probes', 'PUT', { servers: [{ id: serverId, probe_port: 443 }] })).status).toBe(200);
    // смена способа проверки сбрасывает прежние результаты: ping и TCP не сравнимы
    expect((await api('/api/servers')).body[0].probes).toEqual([]);

    await ProbeService.runAll();
    const start = provider.calls.filter((c) => c.path === '/check-tcp').pop()!;
    expect(start.host).toBe('203.0.113.9:443');
    const probes = (await api('/api/servers')).body[0].probes;
    expect(probes).toEqual([
      expect.objectContaining({ country: 'ru', ok_nodes: 2, total_nodes: 2, status: 'ok', rtt_ms: 38 }),
      expect.objectContaining({ country: 'kz', ok_nodes: 0, total_nodes: 1, status: 'fail' }),
    ]);

    db.prepare('UPDATE servers SET host = ? WHERE id = ?').run('2001:db8::1', serverId);
    await ProbeService.runAll();
    expect(provider.calls.filter((c) => c.path === '/check-tcp').pop()!.host).toBe('[2001:db8::1]:443');
    db.prepare('UPDATE servers SET host = ? WHERE id = ?').run('203.0.113.9', serverId);

    await api('/api/probes', 'PUT', { servers: [{ id: serverId, probe_port: null }] });
    expect(db.prepare('SELECT probe_port FROM servers WHERE id = ?').get(serverId)).toEqual({ probe_port: null });
  });

  it('ответ провайдера с чужим request_id или без ok отклоняется, ошибка сохраняется, результаты не портятся', async () => {
    await ProbeService.runAll();
    const before = JSON.stringify((await api('/api/servers')).body[0].probes);

    provider.startReply = { ok: 1, request_id: '../../etc/passwd', nodes: {} };
    const bad = await ProbeService.runAll();
    expect(bad.checked).toBe(0);
    expect(bad.errors[0]).toContain('Frankfurt');
    expect(getSetting('probe_error')).toContain('Frankfurt');
    expect(JSON.stringify((await api('/api/servers')).body[0].probes)).toBe(before);

    provider.startReply = { ok: 0, error: 'limit exceeded' };
    expect((await ProbeService.runAll()).errors[0]).toContain('limit exceeded');
  });

  it('недоступный провайдер не ломает цикл: ошибка записывается, прежние результаты на месте', async () => {
    await ProbeService.runAll();
    provider.failNodesList = true;
    ProbeService.resetCountriesCache();
    const result = await ProbeService.runAll();
    expect(result.checked).toBe(0);
    expect(getSetting('probe_error')).toContain('check-host.net');
    expect((await api('/api/servers')).body[0].probes.length).toBeGreaterThan(0);
  });

  it('страна без проверяющих узлов отмечается в ошибке, остальные проверяются', async () => {
    await api('/api/probes', 'PUT', { settings: { countries: ['ru', 'zz'] } });
    ProbeService.resetCountriesCache();
    const result = await ProbeService.runAll();
    expect(result.checked).toBe(1);
    expect(result.errors).toEqual(['нет проверяющих узлов в странах: ZZ']);
    await api('/api/probes', 'PUT', { settings: { countries: ['ru', 'kz'] } });
  });

  it('ручной запуск: 202 и фоновая проверка; повторный в течение минуты — 429; без включения — 400', async () => {
    expect((await api('/api/probes/run', 'POST')).status).toBe(429);
    setSetting('probe_last_run', new Date(Date.now() - 5 * 60000).toISOString());
    const started = await api('/api/probes/run', 'POST');
    expect(started.status).toBe(202);
    await vi.waitFor(() => expect((ProbeService.getStatus().running)).toBe(false));
    await vi.waitFor(() => expect(Date.now() - new Date(getSetting('probe_last_run')!).getTime()).toBeLessThan(5000));

    await api('/api/probes', 'PUT', { settings: { enabled: false } });
    expect((await api('/api/probes/run', 'POST')).status).toBe(400);
    await api('/api/probes', 'PUT', { settings: { enabled: true } });
  });

  it('очередной обход по расписанию: пора только когда прошёл интервал', () => {
    setSetting('probe_last_run', new Date().toISOString());
    expect(ProbeService.isDue()).toBe(false);
    setSetting('probe_last_run', new Date(Date.now() - 31 * 60000).toISOString());
    expect(ProbeService.isDue()).toBe(true);
    setSetting('probe_last_run', null);
    expect(ProbeService.isDue()).toBe(true);
  });
});

describe('доступность в подписке', () => {
  beforeAll(async () => {
    await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['ru', 'kz'], show_in_name: true, show_in_description: true } });
    await api('/api/subscription-settings', 'PUT', { settings: { description: 'Быстрые серверы' } });
    setSetting('probe_last_run', null);
    await ProbeService.runAll();
  });

  it('к названию ноды дописываются флаги стран и статусы, к описанию — пояснение', async () => {
    const res = await env.request(`/sub/${subToken}`);
    expect(res.status).toBe(200);
    expect(decodeLinks(await res.text())).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);

    const description = decodeHeader(res.headers.get('profile-description'));
    expect(description).toContain('Быстрые серверы');
    expect(description).toContain('Доступность нод из стран: 🇷🇺 Россия, 🇰🇿 Казахстан');
    expect(description).toContain('✅ доступна');
    expect(description).toMatch(/Проверено \d{2}\.\d{2} \d{2}:\d{2} UTC\./);
    // Заголовки только ASCII (инвариант 19): значение передано как base64
    expect(res.headers.get('profile-description')).toMatch(/^base64:[A-Za-z0-9+/=]+$/);
  });

  it('те же названия в JSON-контейнере и в формате mihomo', async () => {
    const json = (await (await env.request(`/sub/${subToken}?format=json`)).json()) as any;
    expect(json.servers.map((s: any) => s.name)).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);
    const clash = JSON.parse(await (await env.request(`/sub/${subToken}?format=clash`)).text());
    expect(clash.proxies.map((p: any) => p.name)).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);
  });

  it('отображаемое имя сервера (sub_name) сохраняется, пометки добавляются после него', async () => {
    db.prepare('UPDATE servers SET sub_name = ? WHERE id = ?').run('🇩🇪 Германия', serverId);
    try {
      const res = await env.request(`/sub/${subToken}`);
      expect(decodeLinks(await res.text())).toEqual(['🇩🇪 Германия · 🇷🇺⚠️ 🇰🇿❌']);
    } finally {
      db.prepare('UPDATE servers SET sub_name = NULL WHERE id = ?').run(serverId);
    }
  });

  it('переключатели: без пометок в названии и/или без пояснения в описании', async () => {
    await api('/api/probes', 'PUT', { settings: { show_in_name: false } });
    const noName = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await noName.text())).toEqual(['Frankfurt']);
    expect(decodeHeader(noName.headers.get('profile-description'))).toContain('Доступность нод из стран');

    await api('/api/probes', 'PUT', { settings: { show_in_name: true, show_in_description: false } });
    const noLegend = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await noLegend.text())).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);
    expect(decodeHeader(noLegend.headers.get('profile-description'))).toBe('Быстрые серверы');
    await api('/api/probes', 'PUT', { settings: { show_in_description: true } });
  });

  it('устаревшие результаты в подписку не попадают, выключенная проверка — тоже', async () => {
    db.prepare('UPDATE probe_results SET checked_at = ?').run(new Date(Date.now() - 4 * 3600 * 1000).toISOString());
    const stale = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await stale.text())).toEqual(['Frankfurt']);
    expect(decodeHeader(stale.headers.get('profile-description'))).toBe('Быстрые серверы');
    expect((await api('/api/servers')).body[0].probes).toEqual([]);

    await ProbeService.runAll();
    expect(decodeLinks(await (await env.request(`/sub/${subToken}`)).text())).toEqual(['Frankfurt · 🇷🇺⚠️ 🇰🇿❌']);

    await api('/api/probes', 'PUT', { settings: { enabled: false } });
    const off = await env.request(`/sub/${subToken}`);
    expect(decodeLinks(await off.text())).toEqual(['Frankfurt']);
    expect(decodeHeader(off.headers.get('profile-description'))).toBe('Быстрые серверы');
  });

  it('страна, убранная из списка, пропадает из результатов сразу', async () => {
    await api('/api/probes', 'PUT', { settings: { enabled: true, countries: ['ru', 'kz'] } });
    await ProbeService.runAll();
    await api('/api/probes', 'PUT', { settings: { countries: ['kz'] } });
    expect(db.prepare('SELECT country FROM probe_results').all()).toEqual([{ country: 'kz' }]);
    expect(decodeLinks(await (await env.request(`/sub/${subToken}`)).text())).toEqual(['Frankfurt · 🇰🇿❌']);
  });

  it('удаление сервера удаляет и его результаты', async () => {
    const tempId = insertServer({ name: 'Temp', host: '203.0.113.77' });
    db.prepare('INSERT INTO probe_results (server_id, country, ok_nodes, total_nodes, rtt_ms, checked_at) VALUES (?, ?, 1, 1, 10, ?)').run(tempId, 'kz', new Date().toISOString());
    db.prepare('DELETE FROM servers WHERE id = ?').run(tempId);
    expect(db.prepare('SELECT COUNT(*) AS c FROM probe_results WHERE server_id = ?').get(tempId)).toEqual({ c: 0 });
  });
});
