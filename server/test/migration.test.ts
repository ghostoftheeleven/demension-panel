import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getSetting, initDatabase, setSetting } from '../src/db/index.js';
import { migrationCodeLimiter } from '../src/middleware/rate-limit.js';
import { MigrationService } from '../src/services/migration.service.js';
import { encryptSecret, exportSecretKey } from '../src/services/secrets.service.js';
import { SslService } from '../src/services/ssl.service.js';
import {
  deriveMigrationKeys,
  generateMigrationCode,
  hashAuth,
  normalizeMigrationCode,
  openArchive,
  sealArchive,
  MigrationArchiveError,
  type ArchiveContent,
} from '../src/utils/migration-archive.js';
import { createAdminApi } from './helpers/api.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { cleanupDataDirs, newDataDir, readDb, runCli } from './helpers/migration-cli.js';
import { startTestServer, type TestEnv } from './test-app.js';

/**
 * Перенос панели на другой сервер: формат архива, поведение прежней панели (код, блокировка изменений, заморозка) и
 * полный круг «экспорт → импорт CLI» в отдельный каталог данных, как это делает install.sh.
 */

let env: TestEnv;
let api: ReturnType<typeof createAdminApi>['api'];
const ADMIN_PASSWORD = 'MigAdminPass-1';

beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  ({ api } = createAdminApi(env, 'migadmin', ADMIN_PASSWORD));
});

afterAll(async () => {
  await env.close();
  cleanupDataDirs();
});

describe('архив переноса: примитивы', () => {
  it('код — 25 символов без похожих O/0/I/1 в группах по 5; коды не повторяются', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateMigrationCode();
      expect(code).toMatch(/^([A-HJ-NP-Z2-9]{5}-){4}[A-HJ-NP-Z2-9]{5}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(500);
  });

  it('нормализация принимает строчные буквы, пробелы и ввод без дефисов; чужие символы отклоняет', () => {
    const code = generateMigrationCode();
    expect(normalizeMigrationCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(normalizeMigrationCode(code.replace(/-/g, ''))).toBe(code.replace(/-/g, ''));
    expect(normalizeMigrationCode('ABCDE-FGHJK')).toBeNull();
    expect(normalizeMigrationCode(code.replace(/^./, 'O'))).toBeNull();
    expect(() => deriveMigrationKeys('короткий')).toThrow(MigrationArchiveError);
  });

  it('ключи шифрования и доказательства различны и не равны коду; код в разном написании даёт те же ключи', () => {
    const code = generateMigrationCode();
    const a = deriveMigrationKeys(code);
    const b = deriveMigrationKeys(code.toLowerCase());
    expect(a.encKey.equals(b.encKey)).toBe(true);
    expect(a.auth).toBe(b.auth);
    expect(a.auth).toMatch(/^[0-9a-f]{64}$/);
    expect(a.auth).not.toBe(a.encKey.toString('hex'));
    expect(a.auth).not.toContain(code.replace(/-/g, ''));
    expect(deriveMigrationKeys(generateMigrationCode()).auth).not.toBe(a.auth);
  });

  const manifest: ArchiveContent['manifest'] = {
    format: 1, panelVersion: '9.9.9', dbVersion: 7, createdAt: new Date().toISOString(), adminUsername: 'x',
    counts: { servers: 1, remoteServers: 0, clients: 2, subscribers: 3, partners: 0, remotePanels: 0 },
    ssl: { enabled: false, mode: null, domain: null, expiresAt: null, hasFiles: false },
    port: 3001, publicUrl: null, cloudflareTokenSaved: false, sslEmail: null,
  };

  it('запечатанный архив открывается тем же кодом и не читается без него', () => {
    const { encKey } = deriveMigrationKeys(generateMigrationCode());
    const content: ArchiveContent = { manifest, files: { 'demension.db': Buffer.from('SQLITE-BYTES'), 'secret.key': Buffer.from('a2V5\n') } };
    const sealed = sealArchive(content, encKey);

    expect(sealed.includes(Buffer.from('SQLITE-BYTES'))).toBe(false);
    expect(openArchive(sealed, encKey).files['demension.db']!.toString()).toBe('SQLITE-BYTES');
    expect(() => openArchive(sealed, deriveMigrationKeys(generateMigrationCode()).encKey)).toThrow(/неверный код/);
  });

  it('повреждённый или чужой файл отклоняется; в архиве допустимы только известные файлы', () => {
    const { encKey } = deriveMigrationKeys(generateMigrationCode());
    const sealed = sealArchive({ manifest, files: { 'demension.db': Buffer.from('db'), 'secret.key': Buffer.from('k') } }, encKey);

    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => openArchive(tampered, encKey)).toThrow(MigrationArchiveError);
    expect(() => openArchive(Buffer.from('not an archive at all, just text'), encKey)).toThrow(/не архив/);

    // Путь вне разрешённого списка (попытка записать файл за пределы каталога данных) не принимается
    const evil = sealArchive(
      { manifest, files: { 'demension.db': Buffer.from('db'), 'secret.key': Buffer.from('k'), '../../etc/cron.d/x': Buffer.from('boom') } as any },
      encKey
    );
    expect(() => openArchive(evil, encKey)).toThrow(/неожиданный файл/);

    const noDb = sealArchive({ manifest, files: { 'secret.key': Buffer.from('k') } }, encKey);
    expect(() => openArchive(noDb, encKey)).toThrow(/нет базы данных/);
  });
});

describe('прежняя панель: выдача кода, архив, блокировка и заморозка', () => {
  let code: string;
  let auth: string;
  let sshSecret: string;

  beforeAll(async () => {
    const serverId = insertServer({ name: 'Frankfurt', host: '198.51.100.20', sshPassword: 'ssh-password-in-db' });
    const subscriberId = insertSubscriber({ name: 'alice' });
    insertClient(serverId, { name: 'alice-phone', subscriberId });
    insertClient(serverId, { name: 'bob-laptop' });
    setSetting('public_url', 'https://old.example.com:3001');
    setSetting('ssl_email', 'admin@example.com');
    setSetting('cf_token', encryptSecret('cf-token-secret'));
    await SslService.generateSelfSignedIpCert('203.0.113.9');
    sshSecret = (db.prepare('SELECT ssh_password FROM servers LIMIT 1').get() as any).ssh_password;
  });

  it('код выдаётся только по паролю администратора; неверный пароль считается и в конце блокируется', async () => {
    const wrong = await api('/api/migration/prepare', 'POST', { password: 'not-my-password' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('Неверный пароль');
    expect((await api('/api/migration/prepare', 'POST', {})).status).toBe(400);
    expect(MigrationService.getState()).toBe('idle');

    const anonymous = await env.request('/api/migration/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(anonymous.status).toBe(401);
    expect((await env.request('/api/migration/status')).status).toBe(401);

    const ok = await api('/api/migration/prepare', 'POST', { password: ADMIN_PASSWORD });
    expect(ok.status).toBe(200);
    code = ok.body.code;
    expect(code).toMatch(/^([A-HJ-NP-Z2-9]{5}-){4}[A-HJ-NP-Z2-9]{5}$/);
    expect(new Date(ok.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    auth = deriveMigrationKeys(code).auth;

    // Код нигде не хранится: в settings только ключ шифрования (зашифрованный) и SHA-256 доказательства
    const stored = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'migration\\_%' ESCAPE '\\'").all() as any[];
    expect(JSON.stringify(stored)).not.toContain(code.replace(/-/g, ''));
    expect(getSetting('migration_auth_hash')).toBe(hashAuth(auth));
    expect(getSetting('migration_key')).toMatch(/^enc:v1:/);
    expect((await api('/api/migration/status')).body.state).toBe('prepared');
  });

  it('архив по коду: без заголовка и с чужим кодом — 403, после 10 неудач с адреса — 429 даже с верным кодом', async () => {
    const url = '/api/migration/archive';
    expect((await env.request(url)).status).toBe(403);
    expect((await env.request(url, { headers: { 'X-Migration-Auth': 'zz' } })).status).toBe(403);
    expect((await env.request(url, { headers: { 'X-Migration-Auth': deriveMigrationKeys(generateMigrationCode()).auth } })).status).toBe(403);
    // Сам код (а не производная) заголовком не принимается
    expect((await env.request(url, { headers: { 'X-Migration-Auth': code } })).status).toBe(403);
    expect(MigrationService.getState()).toBe('prepared');

    for (let i = 0; i < 6; i++) await env.request(url);
    const blocked = await env.request(url, { headers: { 'X-Migration-Auth': auth } });
    expect(blocked.status).toBe(429);
    migrationCodeLimiter.reset('127.0.0.1');
    migrationCodeLimiter.reset('::ffff:127.0.0.1');
    migrationCodeLimiter.reset('::1');
  });

  it('верный код отдаёт зашифрованный архив: в нём БД, ключ шифрования и сертификат, но нет сессий и служебных данных', async () => {
    const res = await env.request('/api/migration/archive', { headers: { 'X-Migration-Auth': auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const sealed = Buffer.from(await res.arrayBuffer());
    expect(sealed.includes(Buffer.from('Frankfurt'))).toBe(false);
    expect(sealed.includes(Buffer.from('ssh-password-in-db'))).toBe(false);

    const { manifest, files } = openArchive(sealed, deriveMigrationKeys(code).encKey);
    expect(manifest.counts).toMatchObject({ servers: 1, clients: 2, subscribers: 1 });
    expect(manifest.adminUsername).toBe('migadmin');
    expect(manifest.cloudflareTokenSaved).toBe(true);
    expect(manifest.sslEmail).toBe('admin@example.com');
    expect(manifest.ssl).toMatchObject({ enabled: true, mode: 'selfsigned_ip', domain: '203.0.113.9', hasFiles: true });
    expect(files['secret.key']!.toString().trim()).toBe(exportSecretKey());
    expect(files['ssl/fullchain.pem']!.toString()).toContain('BEGIN CERTIFICATE');
    expect(files['ssl/privkey.pem']!.toString()).toContain('PRIVATE KEY');

    // Снимок БД — настоящая SQLite с той же версией схемы; сессий и данных переноса в нём нет
    const snapshotPath = path.join(newDataDir(), 'snapshot.db');
    fs.writeFileSync(snapshotPath, files['demension.db']!);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    expect((snapshot.prepare('PRAGMA user_version').get() as any).user_version).toBe(manifest.dbVersion);
    expect((snapshot.prepare('SELECT COUNT(*) AS c FROM sessions').get() as any).c).toBe(0);
    expect((snapshot.prepare("SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'migration\\_%' ESCAPE '\\'").get() as any).c).toBe(0);
    expect((snapshot.prepare('SELECT ssh_password FROM servers').get() as any).ssh_password).toBe(sshSecret);
    snapshot.close();

    expect(MigrationService.getState()).toBe('exporting');
  });

  it('пока архив передан, записи блокируются (423), чтение, вход и отмена работают; фоновые задачи на паузе', async () => {
    expect(MigrationService.isBackgroundPaused()).toBe(true);

    const blocked = await api('/api/servers', 'POST', { name: 'new', host: '203.0.113.50', ssh_password: 'x' });
    expect(blocked.status).toBe(423);
    expect(blocked.body.error).toContain('Идёт перенос панели');
    expect((await api('/api/subscribers', 'POST', { name: 'late-user', server_ids: [] })).status).toBe(423);
    expect((await api('/api/auth/change-password', 'POST', { oldPassword: ADMIN_PASSWORD, newPassword: 'AnotherPass-12' })).status).toBe(423);

    expect((await api('/api/servers')).status).toBe(200);
    expect((await api('/api/migration/status')).body.state).toBe('exporting');
    expect((await env.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'migadmin', password: ADMIN_PASSWORD }) })).status).toBe(200);
  });

  it('отмена возвращает панель в обычный режим, а код перестаёт действовать', async () => {
    expect((await api('/api/migration/cancel', 'POST')).status).toBe(200);
    expect(MigrationService.getState()).toBe('idle');
    expect(MigrationService.isBackgroundPaused()).toBe(false);
    expect((await env.request('/api/migration/archive', { headers: { 'X-Migration-Auth': auth } })).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'migration\\_%' ESCAPE '\\'").get()).toMatchObject({ c: 0 });
    migrationCodeLimiter.reset('127.0.0.1');
    migrationCodeLimiter.reset('::ffff:127.0.0.1');
    migrationCodeLimiter.reset('::1');
  });

  it('без выданного кода архив собрать нельзя; просроченный код не принимается', async () => {
    expect(() => MigrationService.buildArchive()).toThrow(/не подготовлен/);

    const fresh = MigrationService.prepare();
    setSetting('migration_expires_at', new Date(Date.now() - 1000).toISOString());
    expect(MigrationService.verifyAuth(deriveMigrationKeys(fresh.code).auth)).toBe(false);
    expect(MigrationService.getState()).toBe('idle');
  });

  it('блокировка изменений снимается сама, если перенос не завершён за отведённое время', async () => {
    const fresh = MigrationService.prepare();
    MigrationService.buildArchive();
    expect(MigrationService.getState()).toBe('exporting');
    setSetting('migration_expires_at', new Date(Date.now() - 1000).toISOString());
    expect(MigrationService.getState()).toBe('idle');
    expect(MigrationService.verifyAuth(deriveMigrationKeys(fresh.code).auth)).toBe(false);
  });

  it('завершение: панель замораживается — вход и API дают 410, ссылки подписок перенаправляются на новый адрес', async () => {
    const fresh = MigrationService.prepare();
    const freshAuth = deriveMigrationKeys(fresh.code).auth;
    const subToken = (db.prepare('SELECT token FROM subscribers LIMIT 1').get() as any).token;

    // finish до передачи архива не принимается
    expect((await env.request('/api/migration/finish', { method: 'POST', headers: { 'X-Migration-Auth': freshAuth, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(409);

    MigrationService.buildArchive();
    const finish = await env.request('/api/migration/finish', {
      method: 'POST',
      headers: { 'X-Migration-Auth': freshAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ newUrl: 'https://new.example.com:3001/ignored/path' }),
    });
    expect(finish.status).toBe(200);
    expect(MigrationService.getState()).toBe('migrated');
    expect(getSetting('migration_new_url')).toBe('https://new.example.com:3001');
    expect(getSetting('migration_key')).toBeNull();
    expect(getSetting('migration_auth_hash')).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as any).c).toBe(0);
    expect(MigrationService.isBackgroundPaused()).toBe(true);

    const login = await env.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'migadmin', password: ADMIN_PASSWORD }) });
    expect(login.status).toBe(410);
    expect(((await login.json()) as any).newUrl).toBe('https://new.example.com:3001');
    expect((await api('/api/servers')).status).toBe(410);

    const redirect = await env.request(`/sub/${subToken}?format=clash`, { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe(`https://new.example.com:3001/sub/${subToken}?format=clash`);

    // Повторное завершение и выдача нового кода у замороженной панели невозможны
    expect((await env.request('/api/migration/archive', { headers: { 'X-Migration-Auth': freshAuth } })).status).toBe(410);
    expect(() => MigrationService.prepare()).toThrow(/уже перенесена/);

    // Снятие заморозки (CLI resume) возвращает обычную работу
    MigrationService.cancel();
    expect(MigrationService.getState()).toBe('idle');
    expect((await env.request(`/sub/${subToken}`)).status).toBe(200);
  });
});

describe('новая панель: импорт архива CLI в чистый каталог данных', () => {
  let code: string;
  let archive: Buffer;
  let oldSecretKey: string;

  beforeAll(() => {
    code = MigrationService.prepare().code;
    archive = MigrationService.buildArchive();
    oldSecretKey = exportSecretKey();
    // Архив снят в состоянии prepared: служебные настройки переноса в нём быть не должны
    MigrationService.cancel();
  });

  it('файл: данные, ключ шифрования и сертификат переносятся, сессии и служебные настройки — нет', async () => {
    const dataDir = newDataDir();
    const file = path.join(dataDir, 'incoming.dpm');
    fs.writeFileSync(file, archive);

    const result = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('серверов 1');
    expect(result.stdout).not.toMatch(/vv\d/);
    expect(result.stdout).toMatch(/Данные прежней панели \(v\d+\.\d+\.\d+\) перенесены/);
    expect(result.stdout).not.toContain(code);
    expect(result.values).toMatchObject({
      old_admin: 'migadmin', servers: '1', clients: '2', subscribers: '1', ssl_cert_ok: '1', ssl_domain: '203.0.113.9',
      cf_token_saved: '1', ssl_email: 'admin@example.com', public_url_set: '1', old_port: '3001',
    });

    expect(fs.readFileSync(path.join(dataDir, 'secret.key'), 'utf-8').trim()).toBe(oldSecretKey);
    expect(fs.existsSync(path.join(dataDir, 'ssl', 'fullchain.pem'))).toBe(true);
    expect(readDb<any>(dataDir, 'SELECT username FROM admins')).toEqual([{ username: 'migadmin' }]);
    expect(readDb<any>(dataDir, 'SELECT name, host FROM servers')).toEqual([{ name: 'Frankfurt', host: '198.51.100.20' }]);
    expect(readDb<any>(dataDir, 'SELECT COUNT(*) AS c FROM clients')[0].c).toBe(2);
    expect(readDb<any>(dataDir, 'SELECT COUNT(*) AS c FROM sessions')[0].c).toBe(0);
    expect(readDb<any>(dataDir, "SELECT COUNT(*) AS c FROM settings WHERE key LIKE 'migration\\_%' ESCAPE '\\'")[0].c).toBe(0);
    expect(readDb<any>(dataDir, "SELECT value FROM settings WHERE key = 'public_url'")[0].value).toBe('https://old.example.com:3001');
    // Секреты в БД остались зашифрованными тем же ключом
    expect(readDb<any>(dataDir, 'SELECT ssh_password FROM servers')[0].ssh_password).toMatch(/^enc:v1:/);
    // Ключ шифрования и приватный ключ TLS доступны только владельцу
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dataDir, 'secret.key')).mode & 0o077).toBe(0);
      expect(fs.statSync(path.join(dataDir, 'ssl', 'privkey.pem')).mode & 0o077).toBe(0);
      expect(fs.statSync(path.join(dataDir, 'dementia.db')).mode & 0o077).toBe(0);
    }
  }, 120000);

  it('неверный код: ничего не записывается, код возврата 1', async () => {
    const dataDir = newDataDir();
    const file = path.join(dataDir, 'incoming.dpm');
    fs.writeFileSync(file, archive);

    const result = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: generateMigrationCode() });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('неверный код переноса');
    expect(fs.existsSync(path.join(dataDir, 'dementia.db'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'secret.key'))).toBe(false);

    const noCode = await runCli(['file', '--path', file], dataDir);
    expect(noCode.status).toBe(2);
    expect(noCode.stderr).toContain('MIGRATION_CODE');
  }, 120000);

  it('сеть: CLI забирает архив у работающей панели по коду, а завершение замораживает её и задаёт адрес перенаправления', async () => {
    const dataDir = newDataDir();
    MigrationService.cancel();
    const fresh = MigrationService.prepare();

    const pull = await runCli(['pull', '--from', env.baseUrl], dataDir, { MIGRATION_CODE: fresh.code });
    expect(pull.status, pull.stderr).toBe(0);
    expect(pull.values.servers).toBe('1');
    expect(MigrationService.getState()).toBe('exporting');
    expect(readDb<any>(dataDir, 'SELECT COUNT(*) AS c FROM clients')[0].c).toBe(2);

    const wrongCode = await runCli(['finish', '--from', env.baseUrl, '--new-url', 'https://new.example.com:3001'], dataDir, { MIGRATION_CODE: generateMigrationCode() });
    expect(wrongCode.status).toBe(1);
    expect(wrongCode.stderr).toContain('Неверный или просроченный код');
    expect(MigrationService.getState()).toBe('exporting');
    migrationCodeLimiter.reset('127.0.0.1');
    migrationCodeLimiter.reset('::ffff:127.0.0.1');

    const finish = await runCli(['finish', '--from', env.baseUrl, '--new-url', 'https://new.example.com:3001'], dataDir, { MIGRATION_CODE: fresh.code });
    expect(finish.status, finish.stderr).toBe(0);
    expect(MigrationService.getState()).toBe('migrated');
    MigrationService.cancel();
  }, 120000);

  it('импорт поверх панели с данными требует --replace и сохраняет копию прежних данных', async () => {
    const dataDir = newDataDir();
    const file = path.join(dataDir, 'incoming.dpm');
    fs.writeFileSync(file, archive);
    expect((await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code })).status).toBe(0);

    // На этом «сервере» уже есть данные: второй импорт без --replace отказывает и ничего не меняет
    const before = fs.readFileSync(path.join(dataDir, 'dementia.db'));
    const refused = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code });
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('--replace');
    expect(fs.readFileSync(path.join(dataDir, 'dementia.db')).equals(before)).toBe(true);

    const replaced = await runCli(['file', '--path', file, '--replace'], dataDir, { MIGRATION_CODE: code });
    expect(replaced.status, replaced.stderr).toBe(0);
    const backupDir = replaced.values.backup_dir;
    expect(backupDir).toContain(path.join(dataDir, 'backups', 'pre-migration-'));
    expect(fs.readdirSync(backupDir).some((name) => name.includes('dementia.db'))).toBe(true);
    expect(fs.readdirSync(backupDir).some((name) => name.includes('secret.key'))).toBe(true);
  }, 180000);

  it('другой DEMENTIA_SECRET_KEY в окружении отклоняется до записи: иначе SSH-доступы к нодам не расшифровались бы', async () => {
    const dataDir = newDataDir();
    const file = path.join(dataDir, 'incoming.dpm');
    fs.writeFileSync(file, archive);

    const result = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code, DEMENTIA_SECRET_KEY: Buffer.alloc(32, 7).toString('base64') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DEMENTIA_SECRET_KEY');
    expect(fs.existsSync(path.join(dataDir, 'dementia.db'))).toBe(false);
  }, 120000);
});
