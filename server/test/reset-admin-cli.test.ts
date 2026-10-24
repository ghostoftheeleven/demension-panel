import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/services/auth.service.js';

/**
 * CLI сброса логина и пароля администратора (его вызывает и install.sh): запускается как отдельный процесс на пустой БД.
 */

const SERVER_DIR = path.resolve(__dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(env: Record<string, string>, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demension-cli-'))) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/reset-admin.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DEMENSION_DATA_DIR: dataDir, PANEL_USER: '', PANEL_PASSWORD: '', ...env },
    encoding: 'utf-8',
    timeout: 60000,
  });
  return { ...result, dataDir };
}

function readAdmins(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, 'demension.db'));
  try {
    return {
      admins: db.prepare('SELECT username, password_hash, salt FROM admins').all() as { username: string; password_hash: string; salt: string }[],
      sessions: (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c,
      trusted: (db.prepare('SELECT COUNT(*) AS c FROM trusted_login_ips').get() as { c: number }).c,
    };
  } finally {
    db.close();
  }
}

describe('reset-admin CLI', () => {
  it('создаёт администратора с хэшем пароля (пароль в БД не хранится)', () => {
    const result = runCli({ PANEL_USER: 'root_admin', PANEL_PASSWORD: 'LongEnough-Pass1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Учётные данные администратора "root_admin" обновлены');
    expect(result.stdout).toContain('systemctl restart demension');
    expect(result.stdout + result.stderr).not.toContain('LongEnough-Pass1');
    const { admins } = readAdmins(result.dataDir);
    expect(admins).toHaveLength(1);
    expect(admins[0].username).toBe('root_admin');
    expect(JSON.stringify(admins)).not.toContain('LongEnough-Pass1');
    expect(AuthService.verifyPassword('LongEnough-Pass1', admins[0].password_hash, admins[0].salt)).toBe(true);
    expect(AuthService.verifyPassword('wrong', admins[0].password_hash, admins[0].salt)).toBe(false);
  }, 90000);

  it('по умолчанию логин admin; повторный запуск меняет данные единственного администратора и завершает сессии', () => {
    const first = runCli({ PANEL_PASSWORD: 'FirstPassword-1' });
    expect(readAdmins(first.dataDir).admins[0].username).toBe('admin');

    const db = new DatabaseSync(path.join(first.dataDir, 'demension.db'));
    db.exec("INSERT INTO sessions (token, admin_id, expires_at) VALUES ('x', 1, '2999-01-01T00:00:00.000Z')");
    db.exec("INSERT INTO trusted_login_ips (ip, last_login_at) VALUES ('203.0.113.1', '2999-01-01T00:00:00.000Z')");
    db.close();

    const second = runCli({ PANEL_USER: 'renamed', PANEL_PASSWORD: 'SecondPassword-2' }, first.dataDir);

    expect(second.status).toBe(0);
    const state = readAdmins(first.dataDir);
    expect(state.admins).toHaveLength(1);
    expect(state.admins[0].username).toBe('renamed');
    expect(AuthService.verifyPassword('SecondPassword-2', state.admins[0].password_hash, state.admins[0].salt)).toBe(true);
    expect(state.sessions).toBe(0);
    expect(state.trusted).toBe(0);
  }, 120000);

  it.each([['короткий пароль', 'short'], ['пустой пароль', '']])('%s отклоняется с кодом 1, администратор не создаётся', (_name, password) => {
    const result = runCli({ PANEL_USER: 'admin', PANEL_PASSWORD: password });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('не менее 8 символов');
    // Подключение к файлу БД открывает пустой файл, но схема не создаётся и администратора нет
    expect(() => readAdmins(result.dataDir)).toThrow(/no such table/);
  }, 60000);
});
