import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { PanelArchiveService } from '../src/services/panel-archive.service.js';
import { insertServer } from './helpers/db.js';
import { cleanupDataDirs, newDataDir, readDb } from './helpers/migration-cli.js';

function restore(args: string[], dataDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/restore-backup.ts', ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DEMENTIA_DATA_DIR: dataDir, DEMENTIA_SECRET_KEY: '' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

let archive: Buffer;
let recoveryKey: string;
beforeAll(() => {
  initDatabase();
  AuthService.resetAdmin('backuprestore', 'BackupRestorePass-1');
  insertServer({ name: 'Backup node', host: '198.51.100.44', sshPassword: 'ssh-secret' });
  recoveryKey = crypto.randomBytes(32).toString('base64');
  archive = PanelArchiveService.create(Buffer.from(recoveryKey, 'base64'));
});
afterAll(() => cleanupDataDirs());

describe('восстановление резервной копии CLI', () => {
  it('восстанавливает БД и ключ, а перед заменой сохраняет прежние данные', async () => {
    const dir = newDataDir();
    const file = path.join(dir, 'copy.dpm');
    fs.writeFileSync(file, archive);
    const first = await restore([file, recoveryKey], dir);
    expect(first.status, first.stderr).toBe(0);
    expect(readDb<{ name: string }>(dir, 'SELECT name FROM servers')).toEqual([{ name: 'Backup node' }]);

    const second = await restore([file, recoveryKey], dir);
    expect(second.status, second.stderr).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'backups')).some((name) => name.startsWith('pre-backup-'))).toBe(true);
  }, 120000);

  it('не меняет данные при неверном ключе', async () => {
    const dir = newDataDir();
    const file = path.join(dir, 'copy.dpm');
    fs.writeFileSync(file, archive);
    const result = await restore([file, crypto.randomBytes(32).toString('base64')], dir);
    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(dir, 'dementia.db'))).toBe(false);
  }, 120000);
});
