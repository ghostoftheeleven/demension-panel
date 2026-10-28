import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir, dbFile, sslDir } from '../config.js';
import { panelEnv } from '../utils/env.js';
import {
  ARCHIVE_FILES,
  ARCHIVE_DB_ENTRY,
  ArchiveFileName,
  ExistingDataError,
  MigrationArchiveError,
  MigrationManifest,
  deriveMigrationKeys,
  openArchive,
} from '../utils/migration-archive.js';

/**
 * Перенос панели на другой сервер — сторона новой (принимающей) панели. Выполняется до запуска службы, из CLI
 * (cli/migration.ts, его вызывает install.sh). Модуль не импортирует db/index.ts статически: БД открывается только после
 * того, как файл из архива лёг на место.
 */

export interface ImportResult {
  manifest: MigrationManifest;
  /** Каталог с копией прежних данных этой панели (если они были и заменены) */
  backupDir: string | null;
}

export interface ImportOptions {
  /** Разрешить заменить данные уже работающей панели (копия сохраняется в data/backups) */
  replace?: boolean;
  backupPrefix?: string;
}

function targetPath(name: ArchiveFileName): string {
  return name.startsWith('ssl/') ? path.join(sslDir, name.slice('ssl/'.length)) : path.join(dataDir, name);
}

/** Файлы, которыми перенос владеет (БД со служебными файлами, ключ шифрования, сертификат) */
function ownedPaths(): string[] {
  return [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, ...ARCHIVE_FILES.filter((n) => n !== ARCHIVE_DB_ENTRY).map(targetPath)];
}

/** Есть ли в БД этой панели что терять: ноды, клиенты или пользователи */
function existingPanelHasData(): boolean {
  if (!fs.existsSync(dbFile)) return false;
  let existing: DatabaseSync | null = null;
  try {
    existing = new DatabaseSync(dbFile, { readOnly: true });
    for (const table of ['servers', 'clients', 'subscribers', 'partners', 'admins', 'settings']) {
      const row = existing.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      if (row.c > 0) return true;
    }
    return false;
  } catch {
    // схемы ещё нет (пустой или повреждённый файл) — терять нечего
    return false;
  } finally {
    existing?.close();
  }
}

function writeFileAtomic(file: string, data: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.migrating`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/**
 * Расшифровывает архив и подставляет его содержимое в каталог данных. При любой ошибке прежние файлы восстанавливаются.
 */
export async function importMigrationArchive(archive: Buffer, code: string, options: ImportOptions = {}): Promise<ImportResult> {
  const { encKey } = deriveMigrationKeys(code);
  return importPanelArchive(archive, encKey, options);
}

export async function importPanelArchive(archive: Buffer, encKey: Buffer, options: ImportOptions = {}): Promise<ImportResult> {
  const { manifest, files } = openArchive(archive, encKey);

  const secretKey = files['secret.key']!.toString('utf8').trim();
  if (Buffer.from(secretKey, 'base64').length !== 32) throw new MigrationArchiveError('В архиве повреждён ключ шифрования');
  // Ключ из окружения приоритетнее файла: другой ключ не расшифровал бы SSH-доступы к нодам
  const envKey = panelEnv('SECRET_KEY');
  if (envKey && Buffer.from(envKey, 'base64').toString('base64') !== Buffer.from(secretKey, 'base64').toString('base64')) {
    throw new MigrationArchiveError(
      'В окружении задан DEMENTIA_SECRET_KEY, отличающийся от ключа прежней панели: уберите его из server/.env (ключ приходит вместе с архивом)'
    );
  }

  const hadData = existingPanelHasData();
  if (hadData && !options.replace) {
    throw new ExistingDataError('На этом сервере уже есть панель с данными: перенос заменит их (укажите --replace; копия будет сохранена)');
  }

  // Копия прежних данных: для пользователя (на диске) и для отката при ошибке (в памяти)
  const previous = new Map<string, Buffer | null>();
  for (const file of ownedPaths()) previous.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
  let backupDir: string | null = null;
  if (hadData) {
    backupDir = path.join(dataDir, 'backups', `${options.backupPrefix || 'pre-migration'}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (const [file, content] of previous) {
      if (content) fs.writeFileSync(path.join(backupDir, path.relative(dataDir, file).replace(/[\\/]/g, '__')), content, { mode: 0o600 });
    }
  }

  const restore = () => {
    for (const [file, content] of previous) {
      if (content) writeFileAtomic(file, content, 0o600);
      else fs.rmSync(file, { force: true });
    }
  };

  try {
    for (const file of ownedPaths()) fs.rmSync(file, { force: true });
    writeFileAtomic(dbFile, files[ARCHIVE_DB_ENTRY]!, 0o600);
    writeFileAtomic(targetPath('secret.key'), Buffer.from(secretKey + '\n'), 0o600);
    for (const name of ['ssl/fullchain.pem', 'ssl/privkey.pem', 'ssl/acme-account.key'] as const) {
      const data = files[name];
      if (data) writeFileAtomic(targetPath(name), data, name === 'ssl/fullchain.pem' ? 0o644 : 0o600);
    }

    const { db, initDatabase, SCHEMA_VERSION } = await import('../db/index.js');
    try {
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version > SCHEMA_VERSION) {
        throw new MigrationArchiveError(
          `Архив создан более новой версией панели (схема БД ${version}, эта сборка понимает ${SCHEMA_VERSION}): обновите панель на этом сервере`
        );
      }
      initDatabase();
      db.exec("DELETE FROM sessions; DELETE FROM settings WHERE key LIKE 'migration\\_%' ESCAPE '\\'");

      // Секреты должны расшифровываться ключом из архива — иначе панель потеряла бы SSH-доступы к нодам
      const { decryptSecret } = await import('./secrets.service.js');
      const sample = db.prepare('SELECT ssh_password, ssh_key FROM servers WHERE ssh_password IS NOT NULL OR ssh_key IS NOT NULL LIMIT 1').get() as any;
      if (sample) {
        decryptSecret(sample.ssh_password);
        decryptSecret(sample.ssh_key);
      }
    } finally {
      // Закрытие сливает журнал WAL в файл БД: служба откроет уже готовый файл
      db.close();
    }
  } catch (err) {
    restore();
    throw err;
  }

  return { manifest, backupDir };
}
