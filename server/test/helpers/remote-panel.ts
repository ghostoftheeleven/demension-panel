import { vi } from 'vitest';
import { db } from '../../src/db/index.js';
import { FederationClient } from '../../src/services/federation-client.service.js';

/**
 * Имитация панели владельца нод для сценариев FederationClient: подменяет глобальный fetch и отвечает на
 * /api/federation/v1/* так же, как настоящая панель (создание клиентов идемпотентно по remote_ref).
 */

export const PUBKEY_PLACEHOLDER = 'X'.repeat(43) + '=';
export const PSK_FROM_OWNER = 'B'.repeat(43) + '=';

export const FULL_PARAMS = {
  awg_version: 3, jc: 4, jmin: 40, jmax: 70, s1: 36, s2: 124, s3: 15, s4: 16,
  h1: '100-200', h2: '300-400', h3: '500-600', h4: '700-800',
  i1: null, i2: null, i3: null, i4: null, i5: null, header_protection_key: null, extra_params: {},
};

export interface RemoteState {
  peers: Map<number, any>;
  calls: { method: string; path: string; body: any }[];
  nextPeerId: number;
  nodeName: string;
  nodeParams: Record<string, unknown>;
  nodeHost: string;
  /** IP, который панель владельца вернёт новому клиенту (по умолчанию выдаётся из 10.50.0.0/24) */
  assignedIp?: string;
  /** Ответ на любой запрос с этим HTTP-статусом (например, 403 — доступ отозван) */
  failWith?: number;
  /** Задержка ответа: без неё гонка «ответ раньше синхронизации» не воспроизводится */
  latencyMs: number;
}

export function newRemote(overrides: Partial<RemoteState> = {}): RemoteState {
  return {
    peers: new Map(), calls: [], nextPeerId: 100, nodeName: 'Remote node', nodeParams: FULL_PARAMS,
    nodeHost: '203.0.113.7', latencyMs: 0, ...overrides,
  };
}

/**
 * @param passthroughBaseUrl запросы к этому адресу (тестовый экземпляр самой панели) идут как обычно
 */
export function stubRemotePanel(state: RemoteState, passthroughBaseUrl?: string) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (passthroughBaseUrl && String(url).startsWith(passthroughBaseUrl)) return realFetch(url, init);
      const path = String(url).split('/api/federation/v1')[1];
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ method, path, body });
      if (state.latencyMs) await new Promise((resolve) => setTimeout(resolve, state.latencyMs));
      const reply = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

      if (state.failWith) return reply({ error: `simulated ${state.failWith}` }, state.failWith);
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

/** Подключённая панель партнёра с одной нодой (удалённый узел #7); serverId = 0, если нода не принята */
export async function createRemotePanel(state: RemoteState, passthroughBaseUrl?: string): Promise<{ panelId: number; serverId: number }> {
  stubRemotePanel(state, passthroughBaseUrl);
  const panelId = await FederationClient.connect(`https://owner-${++panelCounter}.example.com#dp_${'a'.repeat(32)}`, 'Owner');
  const server = db.prepare('SELECT id FROM servers WHERE remote_panel_id = ?').get(panelId) as { id: number } | undefined;
  return { panelId, serverId: server?.id ?? 0 };
}
