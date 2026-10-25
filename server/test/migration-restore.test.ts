import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, setSetting } from '../src/db/index.js';
import { MigrationService } from '../src/services/migration.service.js';
import { encryptSecret } from '../src/services/secrets.service.js';
import { SslService } from '../src/services/ssl.service.js';
import { deriveMigrationKeys, openArchive, sealArchive } from '../src/utils/migration-archive.js';
import { AuthService } from '../src/services/auth.service.js';
import { insertClient, insertServer, insertSubscriber } from './helpers/db.js';
import { cleanupDataDirs, newDataDir, readDb, runCli } from './helpers/migration-cli.js';

/**
 * Новая панель после импорта: откат при неудаче и выбор сертификата (команды ssl/url CLI, которые вызывает install.sh).
 * Выпуск через Cloudflare и HTTP-01 здесь не проверяется — он требует внешних сервисов (SslService покрыт ssl-service.test.ts).
 */

/** Архив «прежней панели» с данными, сертификатом, токеном Cloudflare и почтой ACME */
async function exportOldPanel(): Promise<{ code: string; archive: Buffer }> {
  const code = MigrationService.prepare().code;
  const archive = MigrationService.buildArchive();
  // Архив снят — вернём панель в обычный режим, чтобы можно было снять следующий
  MigrationService.cancel();
  return { code, archive };
}

async function importInto(dataDir: string, code: string, archive: Buffer): Promise<void> {
  const file = path.join(dataDir, 'incoming.dpm');
  fs.writeFileSync(file, archive);
  const result = await runCli(['file', '--path', file], dataDir, { MIGRATION_CODE: code });
  expect(result.status, result.stderr).toBe(0);
}

beforeAll(async () => {
  initDatabase();
  AuthService.resetAdmin('restoreadmin', 'RestoreAdminPass-1');
  const serverId = insertServer({ name: 'Amsterdam', host: '198.51.100.30', sshPassword: 'ssh-secret' });
  insertClient(serverId, { name: 'carol', subscriberId: insertSubscriber({ name: 'carol' }) });
  setSetting('public_url', 'https://old.example.com:3001');
  setSetting('ssl_email', 'admin@example.com');
  setSetting('cf_token', encryptSecret('cf-token-secret'));
  await SslService.generateSelfSignedIpCert('203.0.113.9');
});

afterAll(() => cleanupDataDirs());

describe('новая панель: откат при неудачном импорте', () => {
  it('архив от более новой версии панели отклоняется, прежние данные остаются на месте', async () => {
    const { code, archive } = await exportOldPanel();
    const dataDir = newDataDir();
    await importInto(dataDir, code, archive);
    const dbBefore = fs.readFileSync(path.join(dataDir, 'demension.db'));
    const keyBefore = fs.readFileSync(path.join(dataDir, 'secret.key'));

    // БД «из будущего»: схема новее, чем умеет эта сборка
    const futureDb = path.join(dataDir, 'future.db');
    const future = new DatabaseSync(futureDb);
    future.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); PRAGMA user_version = 999;');
    future.close();
    const { encKey } = deriveMigrationKeys(code);
    const { manifest } = openArchive(archive, encKey);
    const badFile = path.join(dataDir, 'bad.dpm');
    fs.writeFileSync(
      badFile,
      sealArchive({ manifest, files: { 'demension.db': fs.readFileSync(futureDb), 'secret.key': Buffer.from(Buffer.alloc(32, 9).toString('base64')) } }, encKey)
    );

    const result = await runCli(['file', '--path', badFile, '--replace'], dataDir, { MIGRATION_CODE: code });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('более новой версией панели');
    expect(fs.readFileSync(path.join(dataDir, 'demension.db')).equals(dbBefore)).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'secret.key')).equals(keyBefore)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'ssl', 'fullchain.pem'))).toBe(true);
  }, 180000);

  it('ключ из архива, не подходящий к секретам в БД, отклоняется: панель не должна потерять SSH-доступы к нодам', async () => {
    const { code, archive } = await exportOldPanel();
    const { encKey } = deriveMigrationKeys(code);
    const { manifest, files } = openArchive(archive, encKey);

    const dataDir = newDataDir();
    const badFile = path.join(dataDir, 'wrong-key.dpm');
    fs.writeFileSync(badFile, sealArchive({ manifest, files: { ...files, 'secret.key': Buffer.from(Buffer.alloc(32, 5).toString('base64')) } }, encKey));

    const result = await runCli(['file', '--path', badFile], dataDir, { MIGRATION_CODE: code });
    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(dataDir, 'demension.db'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'secret.key'))).toBe(false);
  }, 120000);
});

describe('новая панель: выбор сертификата после импорта', () => {
  let dataDir: string;
  const ssl = (args: string[], env: Record<string, string> = {}) => runCli(['ssl', ...args], dataDir, env);
  const setting = (key: string): string | null => readDb<any>(dataDir, `SELECT value FROM settings WHERE key = '${key}'`)[0]?.value ?? null;

  beforeAll(async () => {
    const { code, archive } = await exportOldPanel();
    dataDir = newDataDir();
    await importInto(dataDir, code, archive);
  }, 120000);

  it('keep: сертификат прежней панели остаётся, HTTPS включён, режим и домен прежние (автопродление продолжает работать)', async () => {
    const result = await ssl(['--mode', 'keep']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.values).toMatchObject({ ssl_mode: 'selfsigned_ip', ssl_domain: '203.0.113.9', ssl_enabled: '1' });
  }, 120000);

  it('ip: самоподписанный сертификат на указанный IP заменяет прежний', async () => {
    const result = await ssl(['--mode', 'ip', '--ip', '198.51.100.77']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.values).toMatchObject({ ssl_mode: 'selfsigned_ip', ssl_domain: '198.51.100.77', ssl_enabled: '1' });
    expect(setting('ssl_domain')).toBe('198.51.100.77');
  }, 120000);

  it('custom: свой сертификат с этого сервера (пути к файлам); чужой ключ и несуществующие файлы отклоняются', async () => {
    const { generate } = await import('selfsigned');
    const pems = await generate([{ name: 'commonName', value: 'panel.example.com' }], { keySize: 2048, algorithm: 'sha256' });
    const other = await generate([{ name: 'commonName', value: 'other.example.com' }], { keySize: 2048, algorithm: 'sha256' });
    const certFile = path.join(dataDir, 'my-fullchain.pem');
    const keyFile = path.join(dataDir, 'my-privkey.pem');
    const wrongKeyFile = path.join(dataDir, 'other-privkey.pem');
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(wrongKeyFile, other.private);

    const mismatch = await ssl(['--mode', 'custom', '--cert', certFile, '--key', wrongKeyFile]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('не соответствует');
    expect(setting('ssl_mode')).toBe('selfsigned_ip');

    const missing = await ssl(['--mode', 'custom', '--cert', path.join(dataDir, 'nope.pem'), '--key', keyFile]);
    expect(missing.status).toBe(2);

    const ok = await ssl(['--mode', 'custom', '--cert', certFile, '--key', keyFile]);
    expect(ok.status, ok.stderr).toBe(0);
    // Домен берётся из самого сертификата
    expect(ok.values).toMatchObject({ ssl_mode: 'custom', ssl_domain: 'panel.example.com', ssl_enabled: '1' });
    expect(fs.readFileSync(path.join(dataDir, 'ssl', 'fullchain.pem'), 'utf-8')).toBe(pems.cert.trim() + '\n');
  }, 180000);

  it('cf и http без домена отклоняются; токен Cloudflare и почта ACME прежней панели сохранены для выпуска без повторного ввода', async () => {
    const noDomain = await ssl(['--mode', 'cf']);
    expect(noDomain.status).toBe(2);
    expect(noDomain.stderr).toContain('--domain');
    expect((await ssl(['--mode', 'http'])).status).toBe(2);
    expect((await ssl(['--mode', 'unknown'])).status).toBe(2);
    expect(setting('ssl_email')).toBe('admin@example.com');
    expect(setting('cf_token')).toMatch(/^enc:v1:/);
  }, 120000);

  it('url: публичный адрес обновляется, только если он был задан; порт по умолчанию схемы опускается', async () => {
    const first = await runCli(['url', '--host', 'panel.example.com', '--port', '3001'], dataDir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.values.new_url).toBe('https://panel.example.com:3001');
    expect(setting('public_url')).toBe('https://panel.example.com:3001');

    const standard = await runCli(['url', '--host', 'panel.example.com', '--port', '443'], dataDir);
    expect(standard.values.new_url).toBe('https://panel.example.com');

    expect((await runCli(['url', '--host', 'panel.example.com', '--port', '99999'], dataDir)).status).toBe(2);
  }, 120000);

  it('none: HTTPS отключён, файлы сертификата удалены, токен Cloudflare и почта сохранены; без заданного public_url он не появляется', async () => {
    const result = await ssl(['--mode', 'none']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.values.ssl_enabled).toBe('0');
    expect(setting('ssl_mode')).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'ssl', 'fullchain.pem'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'ssl', 'privkey.pem'))).toBe(false);
    expect(setting('cf_token')).toMatch(/^enc:v1:/);

    const target = new DatabaseSync(path.join(dataDir, 'demension.db'));
    target.exec("DELETE FROM settings WHERE key = 'public_url'");
    target.close();
    const url = await runCli(['url', '--host', '203.0.113.5', '--port', '3001'], dataDir);
    expect(url.values.new_url).toBe('http://203.0.113.5:3001');
    expect(setting('public_url')).toBeNull();
  }, 120000);
});
