import { vi } from 'vitest';
import type { SshCall, SshResult } from './ssh-stub.js';

/**
 * Подмена check-host.net и заглушки на ноде для тестов проверки доступности. Сеть не используется: fetch к check-host.net
 * отвечает по сценарию `provider`, а SSH-ответы заглушки (установка, журнал) строит `stubNodeResponder` — в журнал
 * попадают обращения узлов из provider.reach, как если бы они дошли до ноды.
 */

const REAL_FETCH = globalThis.fetch;

export const NODE_IPS: Record<string, string> = {
  'ru1.node.check-host.net': '198.51.100.1',
  'ru2.node.check-host.net': '198.51.100.2',
  'ru3.node.check-host.net': '198.51.100.3',
  'kz1.node.check-host.net': '198.51.100.4',
  'de1.node.check-host.net': '198.51.100.5',
};

export const HTTP_OK = [[1, 0.04, 'OK', '200', '203.0.113.9']];
export const HTTP_FAIL = [[0, 3.0, 'Connection timed out', null, null]];
export const UDP_TIMEOUT = [{ address: '203.0.113.9', timeout: 1 }];

export const provider = {
  nodes: {} as Record<string, [string, string, string]>,
  /** Ответы узлов по типу проверки; ключ отсутствует — узел «ещё считает» */
  http: {} as Record<string, unknown>,
  tcp: {} as Record<string, unknown>,
  udp: {} as Record<string, unknown>,
  /** Какие узлы на самом деле дошли до заглушки ноды (по TCP с меткой и по UDP) */
  reach: { tcp: new Set<string>(), udp: new Set<string>() },
  /** Адрес, с которого узел выходит в сеть, если он отличается от сообщённого check-host.net */
  egress: {} as Record<string, string>,
  calls: [] as { path: string; host?: string; nodes?: string[] }[],
  failNodesList: false,
  failUdpStart: false,
  startReply: null as unknown,
  /** Сколько первых опросов результата узлы отвечают null (ещё считают) */
  pendingPolls: 0,
  polls: {} as Record<string, number>,
  /** Метка последней HTTP-проверки (из адреса запроса) */
  lastNonce: '',
};

export function resetProvider() {
  provider.nodes = {
    'ru1.node.check-host.net': ['ru', 'Russia', 'Moscow'],
    'ru2.node.check-host.net': ['ru', 'Russia', 'Saint Petersburg'],
    'ru3.node.check-host.net': ['ru', 'Russia', 'Novosibirsk'],
    'kz1.node.check-host.net': ['kz', 'Kazakhstan', 'Karaganda'],
    'de1.node.check-host.net': ['de', 'Germany', 'Nuremberg'],
  };
  provider.http = {
    'ru1.node.check-host.net': HTTP_OK,
    'ru2.node.check-host.net': HTTP_OK,
    'kz1.node.check-host.net': HTTP_OK,
    'de1.node.check-host.net': HTTP_OK,
  };
  provider.udp = {
    'ru1.node.check-host.net': [{ address: '203.0.113.9', time: 0.05 }],
    'ru2.node.check-host.net': UDP_TIMEOUT,
    'kz1.node.check-host.net': UDP_TIMEOUT,
    'de1.node.check-host.net': UDP_TIMEOUT,
  };
  provider.tcp = {
    'ru1.node.check-host.net': [{ time: 0.031, address: '203.0.113.9' }],
    'ru2.node.check-host.net': [{ time: 0.044, address: '203.0.113.9' }],
    'kz1.node.check-host.net': [{ error: 'Connection timed out' }],
    'de1.node.check-host.net': [{ time: 0.02, address: '203.0.113.9' }],
  };
  // ru1 дошёл по TCP и UDP; ru2 и kz1 получили «ответ», но до ноды не дошли (подмена)
  provider.reach = { tcp: new Set(['ru1.node.check-host.net']), udp: new Set(['ru1.node.check-host.net']) };
  provider.egress = {};
  provider.calls = [];
  provider.failNodesList = false;
  provider.failUdpStart = false;
  provider.startReply = null;
  provider.pendingPolls = 0;
  provider.polls = {};
  provider.lastNonce = '';
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * fetch к check-host.net — по сценарию; другие адреса — через `other` (по умолчанию настоящий fetch)
 */
export function installProviderStub(other?: (url: URL, init?: any) => Promise<Response> | Response | null) {
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== 'https://check-host.net') {
      const answer = other ? await other(url, init) : null;
      return answer ?? REAL_FETCH(input, init);
    }

    if (url.pathname === '/nodes/hosts') {
      provider.calls.push({ path: url.pathname });
      if (provider.failNodesList) return new Response('upstream down', { status: 503 });
      return json({
        nodes: Object.fromEntries(Object.entries(provider.nodes).map(([id, location]) => [id, { asn: 'AS1', ip: NODE_IPS[id] ?? '192.0.2.1', location }])),
      });
    }
    const start = /^\/check-(http|tcp|udp)$/.exec(url.pathname);
    if (start) {
      const nodes = url.searchParams.getAll('node');
      const host = url.searchParams.get('host') ?? undefined;
      provider.calls.push({ path: url.pathname, host, nodes });
      if (start[1] === 'http' && host) provider.lastNonce = host.split('/').pop() ?? '';
      if (start[1] === 'udp' && provider.failUdpStart) return json({ ok: 0, error: 'udp unavailable' });
      if (provider.startReply) return json(provider.startReply);
      const id = `${start[1]}req1`;
      provider.polls[id] = 0;
      return json({
        ok: 1,
        request_id: id,
        nodes: Object.fromEntries(nodes.map((n) => [n, [...(provider.nodes[n] ?? ['xx']), NODE_IPS[n] ?? '192.0.2.1', 'AS2']])),
      });
    }
    const result = /^\/check-result\/((http|tcp|udp)req1)$/.exec(url.pathname);
    if (result) {
      provider.polls[result[1]] = (provider.polls[result[1]] ?? 0) + 1;
      const source = provider[result[2] as 'http' | 'tcp' | 'udp'];
      const pending = provider.polls[result[1]] <= provider.pendingPolls;
      return json(Object.fromEntries(Object.keys(provider.nodes).map((id) => [id, pending ? null : source[id] ?? null])));
    }
    return new Response('not found', { status: 404 });
  });
}

export interface StubNodeState {
  port: number;
  running: boolean;
  /** Журнал не читается (SSH-ошибка) */
  readFails: boolean;
  installFails: boolean;
  installs: number;
}

export function stubNodeState(port = 34567): StubNodeState {
  return { port, running: true, readFails: false, installFails: false, installs: 0 };
}

/**
 * Ответы SSH для заглушки: установка печатает выбранный порт, чтение журнала — обращения узлов из provider.reach
 */
export function stubNodeResponder(state: StubNodeState) {
  return (call: SshCall): Partial<SshResult> | void => {
    if (call.command.includes('---STUB_PORT')) {
      state.installs++;
      if (state.installFails) return { code: 1, stderr: 'docker: command not found' };
      state.running = true;
      return { stdout: `---STUB_PORT ${state.port}\n` };
    }
    if (call.command.includes('hits.log') && call.command.includes('RUNNING')) {
      if (state.readFails) return { code: 255, stderr: 'ssh: connect timed out' };
      const now = Math.floor(Date.now() / 1000);
      const lines = [`RUNNING ${state.running}`, `${now - 3600} tcp 192.0.2.250 /old`];
      for (const id of provider.reach.tcp) lines.push(`${now} tcp ${provider.egress[id] ?? NODE_IPS[id]} /${provider.lastNonce}`);
      for (const id of provider.reach.udp) lines.push(`${now} udp ${provider.egress[id] ?? NODE_IPS[id]} -`);
      // Мусор и старые записи не засчитываются
      lines.push('garbage line', `${now - 3600} udp 198.51.100.2 -`);
      return { stdout: lines.join('\n') + '\n' };
    }
  };
}
