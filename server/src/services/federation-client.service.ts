import crypto from 'node:crypto';
import { db, transaction } from '../db/index.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { paramsToColumns, AwgParams } from '../utils/awg-params.js';
import { HttpError } from '../utils/http.js';
import { normalizePeerName } from '../utils/names.js';

/**
 * Партнёрский доступ (сторона получателя): ноды другой панели хранятся как серверы с remote_panel_id,
 * клиенты на них создаются здесь (приватный ключ остаётся у нас), а на панель владельца
 * передаётся только публичный ключ.
 */

const API_PREFIX = '/api/federation/v1';
const REQUEST_TIMEOUT_MS = 15000;
/** Временный адрес клиента, пока панель владельца не выдала IP */
export const PENDING_IP_PREFIX = 'pending:';

export class FederationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface RemoteNode {
  id: number;
  name: string;
  host: string;
  port: number;
  public_key: string | null;
  status: string;
  params: AwgParams;
}

interface RemotePeer {
  id: number;
  node_id: number;
  name: string;
  remote_ref: string | null;
  public_key: string;
  client_ip: string;
  preshared_key: string | null;
  enabled: boolean;
  owner_blocked: boolean;
  total_rx: number;
  total_tx: number;
  last_handshake: string | null;
}

const pendingSync = new Map<number, Promise<void>>();
const runningSync = new Map<number, Promise<void>>();

export function isPendingIp(ip: string | null | undefined): boolean {
  return typeof ip === 'string' && ip.startsWith(PENDING_IP_PREFIX);
}

export function pendingIp(): string {
  return PENDING_IP_PREFIX + crypto.randomUUID();
}

/**
 * Разбор строки подключения вида https://panel.example.com#dp_xxx
 */
export function parseConnectString(input: string): { baseUrl: string; token: string } {
  const value = String(input ?? '').trim();
  const hash = value.lastIndexOf('#');
  if (hash < 0) throw new HttpError(400, 'Строка подключения должна иметь вид https://адрес-панели#dp_…');
  const token = value.slice(hash + 1).trim();
  if (!/^dp_[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Некорректный токен партнёра');

  let url: URL;
  try {
    url = new URL(value.slice(0, hash));
  } catch {
    throw new HttpError(400, 'Некорректный адрес панели партнёра');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && process.env.ALLOW_INSECURE_FEDERATION === '1')) {
    throw new HttpError(400, 'Панель партнёра должна быть доступна по HTTPS — иначе токен передаётся открытым текстом');
  }
  return { baseUrl: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`, token };
}

async function call<T>(panel: any, method: string, path: string, body?: unknown): Promise<T> {
  const token = decryptSecret(panel.token);
  let res: Response;
  try {
    res = await fetch(`${panel.base_url}${API_PREFIX}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err: any) {
    throw new FederationError(0, `Панель партнёра недоступна: ${err.cause?.message || err.message}`);
  }
  const data = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new FederationError(res.status, data?.error || `Ошибка панели партнёра (HTTP ${res.status})`);
  return data as T;
}

function loadPanel(panelId: number): any {
  return db.prepare('SELECT * FROM remote_panels WHERE id = ?').get(panelId) as any;
}

export class FederationClient {
  /**
   * Подключить панель партнёра по строке подключения
   */
  static async connect(input: string, name?: string): Promise<number> {
    const { baseUrl, token } = parseConnectString(input);
    const probe = { base_url: baseUrl, token: encryptSecret(token) };
    const info = await call<{ partner_name: string; limits: unknown }>(probe, 'GET', '/info').catch((err: FederationError) => {
      throw new HttpError(err.status === 401 || err.status === 403 ? 400 : 502, err.message);
    });

    const exists = db.prepare('SELECT id FROM remote_panels WHERE base_url = ?').get(baseUrl) as any;
    if (exists) throw new HttpError(409, 'Эта панель уже подключена');

    const label = (name || '').trim().slice(0, 64) || new URL(baseUrl).host;
    const result = db.prepare(`
      INSERT INTO remote_panels (name, base_url, token, partner_name, status, limits) VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(label, baseUrl, probe.token, info.partner_name, JSON.stringify(info.limits ?? null));
    const id = Number(result.lastInsertRowid);
    await this.requestSync(id);
    return id;
  }

  /**
   * Отключить панель: клиенты на её нодах удаляются у владельца (по возможности) и локально
   */
  static async disconnect(panelId: number): Promise<{ remoteCleanup: boolean }> {
    const panel = loadPanel(panelId);
    if (!panel) throw new HttpError(404, 'Панель не найдена');
    let remoteCleanup = true;
    try {
      const { peers } = await call<{ peers: RemotePeer[] }>(panel, 'GET', '/peers');
      for (const peer of peers) await call(panel, 'DELETE', `/peers/${peer.id}`).catch(() => (remoteCleanup = false));
    } catch {
      remoteCleanup = false;
    }
    // Серверы панели и их клиенты удаляются каскадом
    db.prepare('DELETE FROM remote_panels WHERE id = ?').run(panelId);
    return { remoteCleanup };
  }

  /**
   * Запросить синхронизацию панели; повторные запросы, пришедшие во время синхронизации, объединяются в одну следующую
   */
  static requestSync(panelId: number): Promise<void> {
    const pending = pendingSync.get(panelId);
    if (pending) return pending;
    const previous = runningSync.get(panelId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        pendingSync.delete(panelId);
        return this.doSync(panelId);
      });
    pendingSync.set(panelId, next);
    runningSync.set(panelId, next);
    next.finally(() => {
      if (runningSync.get(panelId) === next) runningSync.delete(panelId);
    }).catch(() => {});
    return next;
  }

  static async syncAll(): Promise<void> {
    const panels = db.prepare('SELECT id FROM remote_panels').all() as { id: number }[];
    await Promise.allSettled(panels.map((p) => this.requestSync(p.id)));
  }

  private static async doSync(panelId: number): Promise<void> {
    const panel = loadPanel(panelId);
    if (!panel) return;
    try {
      // 1. Ноды: обновление адресов, ключей и параметров обфускации
      const { nodes, limits } = await call<{ nodes: RemoteNode[]; limits: unknown }>(panel, 'GET', '/nodes');
      this.upsertNodes(panel, nodes);
      db.prepare('UPDATE remote_panels SET limits = ? WHERE id = ?').run(JSON.stringify(limits ?? null), panelId);

      // 2. Клиенты, ещё не созданные у владельца
      const servers = db.prepare("SELECT * FROM servers WHERE remote_panel_id = ? AND status != 'uninstalled'").all(panelId) as any[];
      const errors: string[] = [];
      for (const server of servers) {
        const pending = db.prepare(`
          SELECT c.* FROM clients c WHERE c.server_id = ? AND c.remote_peer_id IS NULL
        `).all(server.id) as any[];
        for (const client of pending) {
          try {
            const { peer } = await call<{ peer: RemotePeer }>(panel, 'POST', '/peers', {
              node_id: server.remote_node_id,
              public_key: client.client_public_key,
              name: normalizePeerName(client.name),
              remote_ref: String(client.id),
              enabled: this.desiredEnabled(client),
            });
            db.prepare('UPDATE clients SET remote_peer_id = ?, client_ip = ?, preshared_key = ?, remote_state = NULL WHERE id = ?').run(
              peer.id,
              peer.client_ip,
              peer.preshared_key,
              client.id
            );
          } catch (err: any) {
            db.prepare('UPDATE clients SET remote_state = ? WHERE id = ?').run(`error: ${err.message}`.slice(0, 300), client.id);
            errors.push(`${client.name}: ${err.message}`);
          }
        }
      }

      // 3. Состояние клиентов у владельца: трафик, блокировки, включение/выключение, удалённые локально
      const { peers } = await call<{ peers: RemotePeer[] }>(panel, 'GET', '/peers');
      const local = db.prepare(`
        SELECT c.*, sub.enabled AS sub_enabled, sub.suspended AS sub_suspended
        FROM clients c
        JOIN servers s ON s.id = c.server_id
        LEFT JOIN subscribers sub ON sub.id = c.subscriber_id
        WHERE s.remote_panel_id = ? AND c.remote_peer_id IS NOT NULL
      `).all(panelId) as any[];
      const byPeerId = new Map(local.map((c) => [c.remote_peer_id, c]));
      const remoteIds = new Set<number>();

      for (const peer of peers) {
        remoteIds.add(peer.id);
        const client = byPeerId.get(peer.id);
        if (!client) {
          // Клиент удалён у нас (вместе с пользователем, нодой из подписки и т.п.) — удаляем у владельца
          await call(panel, 'DELETE', `/peers/${peer.id}`).catch((err) => errors.push(err.message));
          continue;
        }
        db.prepare(`
          UPDATE clients SET total_rx = ?, total_tx = ?, last_handshake = ?, client_ip = ?, remote_state = ? WHERE id = ?
        `).run(peer.total_rx, peer.total_tx, peer.last_handshake, peer.client_ip, peer.owner_blocked ? 'blocked' : null, client.id);
        const patch: { enabled?: boolean; name?: string } = {};
        const desired = this.desiredEnabled(client);
        // Заблокированного владельцем клиента включить нельзя — состояние выровняется после снятия блокировки
        if (desired !== peer.enabled && !(desired && peer.owner_blocked)) patch.enabled = desired;
        // Переименование у нас (клиента или пользователя) передаётся владельцу, иначе у него остаётся прежнее имя
        const name = normalizePeerName(client.name);
        if (name !== peer.name) patch.name = name;
        if (Object.keys(patch).length > 0) {
          await call(panel, 'PATCH', `/peers/${peer.id}`, patch).catch((err) => errors.push(err.message));
        }
      }

      // Пир пропал у владельца (удалён им) — клиент будет создан заново при следующей синхронизации
      for (const client of local) {
        if (!remoteIds.has(client.remote_peer_id)) {
          db.prepare('UPDATE clients SET remote_peer_id = NULL, client_ip = ? WHERE id = ?').run(pendingIp(), client.id);
        }
      }

      db.prepare("UPDATE remote_panels SET status = 'online', last_sync_at = datetime('now'), last_error = ? WHERE id = ?").run(
        errors.length ? errors.slice(0, 3).join('; ') : null,
        panelId
      );
    } catch (err: any) {
      const revoked = err instanceof FederationError && (err.status === 401 || err.status === 403);
      db.prepare('UPDATE remote_panels SET status = ?, last_error = ? WHERE id = ?').run(revoked ? 'revoked' : 'error', err.message, panelId);
      if (revoked) {
        // Доступ отозван: ноды убираются из подписок, клиенты остаются до решения администратора
        db.prepare("UPDATE servers SET status = 'uninstalled', last_error = ? WHERE remote_panel_id = ?").run(err.message, panelId);
      }
    }
  }

  /**
   * Клиент должен быть включён у владельца, если он включён у нас и его пользователь активен
   */
  private static desiredEnabled(client: any): boolean {
    if (!client.enabled) return false;
    if (client.subscriber_id === null || client.subscriber_id === undefined) return true;
    const sub =
      client.sub_enabled !== undefined
        ? { enabled: client.sub_enabled, suspended: client.sub_suspended }
        : (db.prepare('SELECT enabled, suspended FROM subscribers WHERE id = ?').get(client.subscriber_id) as any);
    return Boolean(sub && sub.enabled && !sub.suspended);
  }

  private static upsertNodes(panel: any, nodes: RemoteNode[]): void {
    transaction(() => {
      const seen = new Set<number>();
      for (const node of nodes) {
        seen.add(node.id);
        const status = node.status === 'uninstalled' || !node.public_key ? 'uninstalled' : node.status === 'online' ? 'online' : 'offline';
        const columns = paramsToColumns(node.params);
        const existing = db.prepare('SELECT id FROM servers WHERE remote_panel_id = ? AND remote_node_id = ?').get(panel.id, node.id) as any;
        const common: Record<string, unknown> = {
          name: String(node.name).slice(0, 64),
          host: node.host,
          awg_port: node.port,
          server_public_key: node.public_key,
          status,
          last_error: null,
          ...columns,
        };
        const keys = Object.keys(common);
        if (existing) {
          db.prepare(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')}, last_seen = datetime('now') WHERE id = ?`).run(
            ...(keys.map((k) => common[k]) as any[]),
            existing.id
          );
        } else {
          db.prepare(`
            INSERT INTO servers (${keys.join(', ')}, remote_panel_id, remote_node_id, ssh_user, managed_by, last_seen)
            VALUES (${keys.map(() => '?').join(', ')}, ?, ?, 'partner', 'partner', datetime('now'))
          `).run(...(keys.map((k) => common[k]) as any[]), panel.id, node.id);
        }
      }
      // Ноды, которые владелец больше не предоставляет, убираются из подписок
      const rows = db.prepare('SELECT id, remote_node_id FROM servers WHERE remote_panel_id = ?').all(panel.id) as any[];
      for (const row of rows) {
        if (!seen.has(row.remote_node_id)) {
          db.prepare("UPDATE servers SET status = 'uninstalled', last_error = 'Нода больше не предоставляется партнёром' WHERE id = ?").run(row.id);
        }
      }
    });
  }
}
