import { db } from '../../src/db/index.js';
import { AwgService } from '../../src/services/awg.service.js';
import { encryptSecret } from '../../src/services/secrets.service.js';
import { paramsToColumns } from '../../src/utils/awg-params.js';

/**
 * Прямые вставки в БД для тестов сервисов (в обход HTTP API)
 */

export interface InsertServerOptions {
  name?: string;
  host?: string;
  status?: string;
  awgPort?: number;
  deployedPort?: number | null;
  subnet?: string;
  sshUser?: string;
  sshPassword?: string | null;
  managedBy?: 'demension' | 'amnezia';
  containerName?: string;
  iface?: string;
  confPath?: string;
  awgTool?: 'awg' | 'wg';
  hostKey?: string | null;
  awgVersion?: 1 | 3;
}

let counter = 0;

/** Сервер с параметрами обфускации и ключами; по умолчанию — установленный и онлайн */
export function insertServer(options: InsertServerOptions = {}): number {
  counter++;
  const params = paramsToColumns(AwgService.generateRandomParams(options.awgVersion ?? 3));
  const keys = AwgService.generateKeyPair();
  const columns = [
    'name', 'host', 'ssh_user', 'ssh_password', 'awg_port', 'deployed_port', 'subnet', 'status', 'managed_by', 'container_name',
    'iface', 'conf_path', 'awg_tool', 'host_key', 'server_private_key', 'server_public_key', 'preshared_key', ...Object.keys(params),
  ];
  const values = [
    options.name ?? `Server ${counter}`,
    options.host ?? `192.0.2.${counter}`,
    options.sshUser ?? 'root',
    encryptSecret(options.sshPassword === undefined ? 'secret' : options.sshPassword),
    options.awgPort ?? 51820,
    options.deployedPort === undefined ? options.awgPort ?? 51820 : options.deployedPort,
    options.subnet ?? '10.8.0.1/24',
    options.status ?? 'online',
    options.managedBy ?? 'demension',
    options.containerName ?? 'amnezia-awg',
    options.iface ?? 'awg0',
    options.confPath ?? '/opt/amnezia/awg/awg0.conf',
    options.awgTool ?? 'awg',
    options.hostKey ?? null,
    keys.privateKey,
    keys.publicKey,
    AwgService.generatePresharedKey(),
    ...Object.values(params),
  ];
  const result = db.prepare(`INSERT INTO servers (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...(values as any[]));
  return Number(result.lastInsertRowid);
}

export interface InsertClientOptions {
  name?: string;
  ip?: string;
  enabled?: number;
  subscriberId?: number | null;
  publicKey?: string;
  external?: number;
}

export function insertClient(serverId: number, options: InsertClientOptions = {}): { id: number; publicKey: string; privateKey: string; ip: string } {
  counter++;
  const keys = AwgService.generateKeyPair();
  const publicKey = options.publicKey ?? keys.publicKey;
  const ip = options.ip ?? `10.8.0.${(counter % 200) + 2}`;
  const result = db.prepare(`
    INSERT INTO clients (server_id, subscriber_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled, external)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    serverId, options.subscriberId ?? null, options.name ?? `client-${counter}`, ip, publicKey, keys.privateKey,
    AwgService.generatePresharedKey(), options.enabled ?? 1, options.external ?? 0
  );
  return { id: Number(result.lastInsertRowid), publicKey, privateKey: keys.privateKey, ip };
}

export function insertSubscriber(options: { name?: string; enabled?: number; trafficLimit?: number; expireAt?: string | null } = {}): number {
  counter++;
  const result = db.prepare('INSERT INTO subscribers (name, token, enabled, traffic_limit, expire_at) VALUES (?, ?, ?, ?, ?)').run(
    options.name ?? `sub-${counter}`, `sub_test_${counter}_${Math.random().toString(36).slice(2)}`, options.enabled ?? 1,
    options.trafficLimit ?? 0, options.expireAt ?? null
  );
  return Number(result.lastInsertRowid);
}

export function getServer(id: number): any {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}
