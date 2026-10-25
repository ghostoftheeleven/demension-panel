import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDatabase, SCHEMA_VERSION, setSetting } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { MigrationService } from '../src/services/migration.service.js';
import { encryptSecret } from '../src/services/secrets.service.js';
import { SslService } from '../src/services/ssl.service.js';
import { deriveMigrationKeys, openArchive, sealArchive } from '../src/utils/migration-archive.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { cleanupDataDirs, newDataDir, readDb, runCli } from './helpers/migration-cli.js';

/**
 * Перенос ничего не теряет: после «экспорт → импорт» содержимое каждой таблицы совпадает с исходным (кроме сессий и служебных
 * настроек переноса), а архив, снятый панелью со старой схемой БД, при импорте обновляется до текущей.
 */

const SERVER_DIR = path.resolve(__dirname, '..');

function dumpTables(handle: DatabaseSync): Record<string, string[]> {
  const tables = (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  const dump: Record<string, string[]> = {};
  for (const table of tables) {
    const rows = handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    dump[table] = rows
      .filter((row) => !(table === 'settings' && String(row.key).startsWith('migration_')))
      .map((row) => JSON.stringify(row));
  }
  return dump;
}

beforeAll(async () => {
  initDatabase();
  AuthService.resetAdmin('fidelity_admin', 'FidelityPass-123');
  // Данные во всех таблицах панели
  const nodeA = insertServer({ name: 'Node A', host: '198.51.100.71', sshPassword: 'ssh-A', awgVersion: 3 });
  const nodeB = insertServer({ name: 'Node B', host: '198.51.100.72', sshPassword: null, awgVersion: 1, managedBy: 'amnezia', containerName: 'amnezia-awg2' });
  db.prepare("UPDATE servers SET ssh_key = ?, sub_name = '🇩🇪 Берлин', sub_order = 3, needs_sync = 1, probe_port = 443, node_awg_go = 'v0.2.9' WHERE id = ?").run(encryptSecret('-----BEGIN KEY-----'), nodeB);
  const subA = insertSubscriber({ name: 'user-a', trafficLimit: 5 * 1024 ** 3, expireAt: '2027-01-01T00:00:00.000Z' });
  const subB = insertSubscriber({ name: 'пользователь-б', enabled: 0 });
  insertClient(nodeA, { name: 'a-phone', subscriberId: subA });
  insertClient(nodeA, { name: 'a-laptop', subscriberId: subA });
  insertClient(nodeB, { name: 'b-phone', subscriberId: subB });
  insertClient(nodeB, { name: 'imported', external: 1 });
  db.prepare("UPDATE clients SET total_rx = 123456789012, total_tx = 987654321098, rx_counter = 5, tx_counter = 7, last_handshake = '2026-10-24T10:00:00.000Z' WHERE name = 'a-phone'").run();

  db.prepare("INSERT INTO partners (name, token_hash, token_hint, enabled, max_clients, traffic_limit, last_used_at, last_ip) VALUES ('friend', ?, 'dpn_…abcd', 1, 10, 1073741824, '2026-10-24T09:00:00.000Z', '203.0.113.5')").run(crypto.randomBytes(32).toString('hex'));
  db.prepare('INSERT INTO partner_nodes (partner_id, server_id) VALUES (1, ?)').run(nodeA);
  db.prepare("INSERT INTO partner_audit (partner_id, action, details, ip) VALUES (1, 'create_client', 'Иван', '203.0.113.5')").run();
  db.prepare("INSERT INTO remote_panels (name, base_url, token, partner_name, status, limits, last_sync_at) VALUES ('other panel', 'https://other.example.com:3001', ?, 'me', 'online', '{\"max_clients\":5}', '2026-10-24T09:30:00.000Z')").run(encryptSecret('partner-token'));
  db.prepare("INSERT INTO trusted_login_ips (ip, last_login_at) VALUES ('198.51.100.200', ?)").run(new Date().toISOString());
  db.prepare("INSERT INTO probe_results (server_id, country, ok_nodes, total_nodes, rtt_ms, checked_at) VALUES (?, 'ru', 1, 2, 51, '2026-10-24T12:00:00.000Z')").run(nodeA);
  for (const [key, value] of Object.entries({ public_url: 'https://panel.example.com:3001', client_dns: '9.9.9.9', client_mtu: '1380', sub_title: '{user} VPN', sub_announce: 'Плановые работы', ssl_email: 'ops@example.com' })) setSetting(key, value);
  setSetting('cf_token', encryptSecret('cf-secret-token'));
  await SslService.generateSelfSignedIpCert('198.51.100.71');
  // Сессия администратора и данные прошлой попытки переноса не должны переехать
  AuthService.login('fidelity_admin', 'FidelityPass-123');
  MigrationService.prepare();
});

afterAll(() => cleanupDataDirs());

describe('содержимое БД после переноса', () => {
  it('каждая таблица совпадает с исходной; сессий и данных переноса в новой БД нет', async () => {
    const code = (() => {
      MigrationService.cancel();
      return MigrationService.prepare().code;
    })();
    const archive = MigrationService.buildArchive();
    MigrationService.cancel();
    const source = dumpTables(db as unknown as DatabaseSync);
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as any).c).toBeGreaterThan(0);

    const dataDir = newDataDir();
    const file = path.join(dataDir, 'incoming.dpm');
    fs.writeFileSync(file, archive);
    const result = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code });
    expect(result.status, result.stderr).toBe(0);

    const target = new DatabaseSync(path.join(dataDir, 'dementia.db'), { readOnly: true });
    try {
      const imported = dumpTables(target);
      expect(Object.keys(imported)).toEqual(Object.keys(source));
      for (const table of Object.keys(source)) {
        if (table === 'sessions') continue;
        expect(imported[table], `таблица ${table}`).toEqual(source[table]);
      }
      expect(imported.sessions).toEqual([]);
      // Таблицы действительно содержали данные: сравнение не пустое
      for (const table of ['admins', 'servers', 'clients', 'subscribers', 'partners', 'partner_nodes', 'partner_audit', 'remote_panels', 'trusted_login_ips', 'probe_results', 'settings']) {
        expect(source[table].length, `в исходной таблице ${table} нет данных`).toBeGreaterThan(0);
      }
      expect((target.prepare('PRAGMA user_version').get() as any).user_version).toBe(SCHEMA_VERSION);
      expect((target.prepare('PRAGMA integrity_check').get() as any).integrity_check).toBe('ok');
      // Индексы (уникальность IP и ключей клиентов) тоже переехали
      const indexes = (target.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map((i) => i.name);
      const sourceIndexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name").all() as { name: string }[]).map((i) => i.name);
      expect(indexes).toEqual(sourceIndexes);
      expect(indexes).toEqual(expect.arrayContaining(['idx_clients_server_ip', 'idx_clients_server_pubkey']));
    } finally {
      target.close();
    }

    // Пароль администратора проверяется тем же хэшем: вход под прежними данными возможен
    const admin = readDb<{ password_hash: string; salt: string }>(dataDir, 'SELECT password_hash, salt FROM admins')[0];
    expect(AuthService.verifyPassword('FidelityPass-123', admin.password_hash, admin.salt)).toBe(true);
  }, 120000);

  it('большая БД: сотни клиентов и пользователей переносятся целиком', async () => {
    const node = insertServer({ name: 'Bulk node', host: '198.51.100.80' });
    const insertSub = db.prepare('INSERT INTO subscribers (name, token) VALUES (?, ?)');
    const insertPeer = db.prepare('INSERT INTO clients (server_id, subscriber_id, name, client_ip, client_public_key, client_private_key) VALUES (?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 600; i++) {
      const sub = Number(insertSub.run(`bulk-${i}`, `sub_bulk_${i}_${crypto.randomBytes(8).toString('hex')}`).lastInsertRowid);
      insertPeer.run(node, sub, `bulk-${i}`, `10.9.${Math.floor(i / 250)}.${(i % 250) + 2}`, `pub-${i}-${crypto.randomBytes(8).toString('hex')}`, 'priv');
    }
    db.exec('COMMIT');

    MigrationService.cancel();
    const code = MigrationService.prepare().code;
    const archive = MigrationService.buildArchive();
    MigrationService.cancel();
    const dataDir = newDataDir();
    const file = path.join(dataDir, 'incoming.dpm');
    fs.writeFileSync(file, archive);
    const result = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code });
    expect(result.status, result.stderr).toBe(0);
    expect(Number(result.values.clients)).toBeGreaterThanOrEqual(600);
    expect(readDb<{ c: number }>(dataDir, 'SELECT COUNT(*) AS c FROM clients')[0].c).toBe((db.prepare('SELECT COUNT(*) AS c FROM clients').get() as any).c);
    expect(readDb<{ c: number }>(dataDir, 'SELECT COUNT(*) AS c FROM subscribers')[0].c).toBe((db.prepare('SELECT COUNT(*) AS c FROM subscribers').get() as any).c);
  }, 120000);
});

describe('архив со старой схемой БД', () => {
  it('БД версии 7 (панель до проверок из стран) при импорте обновляется до текущей схемы без потери данных', async () => {
    // БД версии 7 готовит отдельный процесс: модуль БД в этом процессе уже открыт
    const legacyDir = newDataDir();
    const script = `
      import { db, initDatabase } from './src/db/index.ts';
      initDatabase(7);
      db.exec("INSERT INTO servers (name, host) VALUES ('legacy', '198.51.100.99')");
      db.exec("INSERT INTO subscribers (name, token) VALUES ('legacy-user', 'sub_legacy_token')");
      db.exec("INSERT INTO settings (key, value) VALUES ('public_url', 'https://legacy.example.com')");
      db.close();
    `;
    const prepared = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: SERVER_DIR,
      env: { ...process.env, DEMENTIA_DATA_DIR: legacyDir },
      encoding: 'utf-8',
      timeout: 60000,
    });
    expect(prepared.status, prepared.stderr).toBe(0);
    const legacyDb = fs.readFileSync(path.join(legacyDir, 'dementia.db'));
    expect(legacyDb.readUInt32BE(60)).toBe(7); // user_version в заголовке файла SQLite

    // Манифест берём у настоящего архива; БД подменяем на старую
    MigrationService.cancel();
    const code = MigrationService.prepare().code;
    const real = openArchive(MigrationService.buildArchive(), deriveMigrationKeys(code).encKey);
    MigrationService.cancel();
    const legacyArchive = sealArchive(
      { manifest: { ...real.manifest, dbVersion: 7 }, files: { 'demension.db': legacyDb, 'secret.key': Buffer.from(crypto.randomBytes(32).toString('base64')) } },
      deriveMigrationKeys(code).encKey
    );

    const dataDir = newDataDir();
    const file = path.join(dataDir, 'legacy.dpm');
    fs.writeFileSync(file, legacyArchive);
    const result = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code });
    expect(result.status, result.stderr).toBe(0);

    expect(readDb<any>(dataDir, 'PRAGMA user_version')[0].user_version).toBe(SCHEMA_VERSION);
    expect(readDb<any>(dataDir, "SELECT name, host, probe_port FROM servers")).toEqual([{ name: 'legacy', host: '198.51.100.99', probe_port: null }]);
    expect(readDb<any>(dataDir, 'SELECT name, token FROM subscribers')).toEqual([{ name: 'legacy-user', token: 'sub_legacy_token' }]);
    expect(readDb<any>(dataDir, "SELECT value FROM settings WHERE key = 'public_url'")).toEqual([{ value: 'https://legacy.example.com' }]);
    expect(readDb<any>(dataDir, "SELECT name FROM sqlite_master WHERE name = 'probe_results'")).toHaveLength(1);
  }, 120000);
});
