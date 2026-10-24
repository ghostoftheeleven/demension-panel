import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Обновление БД с прежних версий схемы (инвариант 21: миграции только добавляются). Каждый сценарий работает с отдельным
 * каталогом данных и заново загруженными модулями, чтобы получить «чужую» БД старой версии.
 */

const dirs: string[] = [];
const openDbs: { close(): void }[] = [];

afterEach(() => {
  for (const handle of openDbs.splice(0)) {
    try {
      handle.close();
    } catch {
      // уже закрыта
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function openFresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demension-migration-'));
  dirs.push(dir);
  process.env.DEMENSION_DATA_DIR = dir;
  vi.resetModules();
  const dbModule = await import('../src/db/index.js');
  const secrets = await import('../src/services/secrets.service.js');
  openDbs.push(dbModule.db);
  return { ...dbModule, secrets };
}

const version = (db: any) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const hasIndex = (db: any, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
const hasTable = (db: any, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const columns = (db: any, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('новая БД', () => {
  it('доходит до последней версии, повторный запуск ничего не меняет', async () => {
    const { db, initDatabase } = await openFresh();
    initDatabase();
    const latest = version(db);
    expect(latest).toBeGreaterThanOrEqual(6);
    const snapshot = JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all());

    initDatabase();
    expect(version(db)).toBe(latest);
    expect(JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all())).toBe(snapshot);
    expect(hasIndex(db, 'idx_clients_server_ip')).toBe(true);
    expect(hasIndex(db, 'idx_clients_server_pubkey')).toBe(true);
    expect(hasTable(db, 'trusted_login_ips')).toBe(true);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });
});

describe('обновление с первой версии', () => {
  async function legacyDatabase() {
    const ctx = await openFresh();
    const { db, initDatabase } = ctx;
    initDatabase(1);
    expect(version(db)).toBe(1);

    db.prepare(`
      INSERT INTO servers (name, host, ssh_password, ssh_key, awg_port, subnet, status, jc, jmin, jmax, s1, s2, h1, h2, h3, h4)
      VALUES ('legacy-online', '198.51.100.1', 'plain-password', '-----BEGIN PRIVATE KEY-----', 51820, '10.8.0.1/24', 'online', 7, 41, 71, 37, 125, 11, 22, 33, 44),
             ('legacy-new', '198.51.100.2', NULL, NULL, 51820, '10.9.0.1/24', 'uninstalled', 4, 40, 70, 36, 124, 1, 2, 3, 4)
    `).run();
    const adminId = Number(db.prepare("INSERT INTO admins (username, password_hash, salt) VALUES ('legacy', 'h', 's')").run().lastInsertRowid);
    db.prepare("INSERT INTO sessions (token, admin_id, expires_at) VALUES ('plain-session-token', ?, '2999-01-01T00:00:00.000Z')").run(adminId);
    db.prepare("INSERT INTO settings (key, value) VALUES ('cf_token', 'plain-cf-token'), ('awg_image', 'old/image:1')").run();
    const insert = db.prepare(`
      INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (1, ?, ?, ?, 'priv')
    `);
    insert.run('first', '10.8.0.2', 'KEY_A');
    insert.run('duplicate-ip', '10.8.0.2', 'KEY_B');
    insert.run('third', '10.8.0.3', 'KEY_C');
    return ctx;
  }

  it('шифрует секреты, сбрасывает открытые сессии и убирает устаревшие настройки', async () => {
    const { db, initDatabase, secrets } = await legacyDatabase();
    initDatabase();

    const server = db.prepare("SELECT ssh_password, ssh_key FROM servers WHERE name = 'legacy-online'").get() as any;
    expect(secrets.isEncrypted(server.ssh_password)).toBe(true);
    expect(secrets.decryptSecret(server.ssh_password)).toBe('plain-password');
    expect(secrets.decryptSecret(server.ssh_key)).toBe('-----BEGIN PRIVATE KEY-----');
    const empty = db.prepare("SELECT ssh_password, ssh_key FROM servers WHERE name = 'legacy-new'").get() as any;
    expect(empty).toEqual({ ssh_password: null, ssh_key: null });

    const token = db.prepare("SELECT value FROM settings WHERE key = 'cf_token'").get() as { value: string };
    expect(secrets.isEncrypted(token.value)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'awg_image'").get()).toEqual({ c: 0 });
  });

  it('исправляет дубли IP клиентов до создания уникального индекса и помечает ноду для синхронизации', async () => {
    const { db, initDatabase } = await legacyDatabase();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    initDatabase();

    const ips = (db.prepare('SELECT client_ip FROM clients WHERE server_id = 1 ORDER BY id').all() as { client_ip: string }[]).map((r) => r.client_ip);
    expect(new Set(ips).size).toBe(3);
    expect(ips[0]).toBe('10.8.0.2');
    expect(ips[2]).toBe('10.8.0.3');
    expect(ips[1]).toMatch(/^10\.8\.0\.\d+$/);
    expect(db.prepare("SELECT needs_sync FROM servers WHERE name = 'legacy-online'").get()).toEqual({ needs_sync: 1 });
    expect(hasIndex(db, 'idx_clients_server_ip')).toBe(true);
  });

  it('сохраняет параметры существующих серверов версии 1.x и ничего не переводит на 3.x молча (инвариант 18)', async () => {
    const { db, initDatabase } = await legacyDatabase();
    initDatabase();

    const row = db.prepare("SELECT awg_version, jc, jmin, jmax, s1, s2, s3, s4, h1, h2, h3, h4, header_protection_key, container_name, iface, managed_by, deployed_port FROM servers WHERE name = 'legacy-online'").get() as any;
    expect(row).toEqual({
      awg_version: 1, jc: 7, jmin: 41, jmax: 71, s1: 37, s2: 125, s3: null, s4: null, h1: 11, h2: 22, h3: 33, h4: 44,
      header_protection_key: null, container_name: 'amnezia-awg', iface: 'awg0', managed_by: 'demension', deployed_port: 51820,
    });
    // Неустановленный сервер порт не «разворачивал»
    expect(db.prepare("SELECT deployed_port FROM servers WHERE name = 'legacy-new'").get()).toEqual({ deployed_port: null });
  });

  it('добавляет все колонки и таблицы последующих версий', async () => {
    const { db, initDatabase } = await legacyDatabase();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    initDatabase();

    expect(columns(db, 'servers')).toEqual(expect.arrayContaining(['host_key', 'needs_sync', 'needs_apply', 'sub_name', 'sub_order', 'awg_version', 'extra_params', 'remote_panel_id', 'remote_node_id']));
    expect(columns(db, 'clients')).toEqual(expect.arrayContaining(['rx_counter', 'external', 'partner_id', 'owner_blocked', 'remote_peer_id', 'remote_state']));
    for (const table of ['partners', 'partner_nodes', 'partner_audit', 'remote_panels', 'trusted_login_ips']) expect(hasTable(db, table), table).toBe(true);
    expect(columns(db, 'subscribers')).toContain('suspended');
  });
});

describe('миграция v6: уникальность ключа клиента на ноде', () => {
  async function atVersion5(duplicate: boolean) {
    const ctx = await openFresh();
    const { db, initDatabase } = ctx;
    initDatabase(5);
    expect(version(db)).toBe(5);
    expect(hasIndex(db, 'idx_clients_server_pubkey')).toBe(false);
    db.prepare("INSERT INTO servers (name, host) VALUES ('s1', '198.51.100.10'), ('s2', '198.51.100.11')").run();
    const insert = db.prepare("INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (?, ?, ?, ?, 'p')");
    insert.run(1, 'a', '10.8.0.2', 'SHARED_KEY');
    insert.run(2, 'b', '10.8.0.2', 'SHARED_KEY'); // тот же ключ на другой ноде — это допустимо
    insert.run(1, 'c', '10.8.0.3', duplicate ? 'SHARED_KEY' : 'OTHER_KEY');
    return ctx;
  }

  it('без дублей создаёт уникальный индекс: ключ на одной ноде повторить нельзя', async () => {
    const { db, initDatabase } = await atVersion5(false);
    initDatabase();
    expect(hasIndex(db, 'idx_clients_server_pubkey')).toBe(true);
    expect(() => db.prepare("INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (1, 'd', '10.8.0.9', 'SHARED_KEY', 'p')").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (2, 'e', '10.8.0.9', 'OTHER_KEY', 'p')").run()).not.toThrow();
  });

  it('при уже существующих дублях индекс не создаётся, запуск не падает, а в журнал выводится предупреждение', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, initDatabase } = await atVersion5(true);
    expect(() => initDatabase()).not.toThrow();

    expect(version(db)).toBeGreaterThanOrEqual(6);
    expect(hasIndex(db, 'idx_clients_server_pubkey')).toBe(false);
    expect(hasTable(db, 'trusted_login_ips')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('одинаковым публичным ключом'));
    expect(db.prepare('SELECT COUNT(*) AS c FROM clients').get()).toEqual({ c: 3 });
  });
});

describe('транзакционность', () => {
  it('ошибка в миграции откатывает её изменения и не повышает версию', async () => {
    const { db, initDatabase, transaction } = await openFresh();
    initDatabase(5);
    expect(() =>
      transaction(() => {
        db.exec('CREATE TABLE should_vanish (id INTEGER)');
        throw new Error('сбой посреди миграции');
      })
    ).toThrow('сбой посреди миграции');
    expect(hasTable(db, 'should_vanish')).toBe(false);
    expect(version(db)).toBe(5);
  });
});
