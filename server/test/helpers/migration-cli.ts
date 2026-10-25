import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Запуск CLI переноса панели (src/cli/migration.ts) как отдельного процесса на собственном каталоге данных.
 */

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const dirs: string[] = [];

export function newDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-migr-'));
  dirs.push(dir);
  return dir;
}

export function cleanupDataDirs(): void {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Строки `@@ключ=значение`, предназначенные для install.sh */
  values: Record<string, string>;
}

/** CLI запускается асинхронно: тестовое приложение живёт в этом же процессе и должно отвечать, пока CLI с ним говорит */
export function runCli(args: string[], dataDir: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/migration.ts', ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, DEMENTIA_DATA_DIR: dataDir, DEMENTIA_SECRET_KEY: '', MIGRATION_CODE: '', CF_API_TOKEN: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => {
      const values: Record<string, string> = {};
      for (const m of stdout.matchAll(/^@@(\w+)=(.*)$/gm)) values[m[1]] = m[2];
      resolve({ status, stdout, stderr, values });
    });
  });
}

/** Чтение БД каталога данных напрямую (только чтение) */
export function readDb<T>(dataDir: string, sql: string): T[] {
  const target = new DatabaseSync(path.join(dataDir, 'dementia.db'), { readOnly: true });
  try {
    return target.prepare(sql).all() as T[];
  } finally {
    target.close();
  }
}
