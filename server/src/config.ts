import fs from 'node:fs';
import path from 'node:path';
import { panelEnv } from './utils/env.js';

/**
 * Каталог данных панели (БД, сертификаты, ключ шифрования).
 * По умолчанию ./data относительно рабочего каталога; можно переопределить DEMENTIA_DATA_DIR.
 */
export const dataDir = path.resolve(panelEnv('DATA_DIR') || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const sslDir = path.join(dataDir, 'ssl');
fs.mkdirSync(sslDir, { recursive: true, mode: 0o700 });

/** Файл БД. До v0.1.4 (проект назывался Demension) он назывался demension.db */
export const dbFile = path.join(dataDir, 'dementia.db');

/**
 * Прежний файл БД переименовывается при первом запуске новой версии. Если есть оба файла, прежний новее по смыслу:
 * так бывает только после отката обновления на версию до переименования — она писала в demension.db. Тогда
 * dementia.db откладывается в data/backups, а не удаляется.
 */
export function adoptLegacyDatabase(dir: string = dataDir): void {
  const dbFile = path.join(dir, 'dementia.db');
  const legacyDbFile = path.join(dir, 'demension.db');
  if (!fs.existsSync(legacyDbFile)) return;
  if (fs.existsSync(dbFile)) {
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbFile + suffix)) fs.renameSync(dbFile + suffix, path.join(backupDir, `dementia.db${suffix}.superseded-${stamp}`));
    }
  }
  for (const suffix of ['-wal', '-shm', '']) {
    if (fs.existsSync(legacyDbFile + suffix)) fs.renameSync(legacyDbFile + suffix, dbFile + suffix);
  }
}
adoptLegacyDatabase();
