import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * Архив переноса панели: БД, ключ шифрования секретов и сертификат в одном зашифрованном файле.
 *
 * Ключи выводятся из кода переноса (25 случайных символов, ≈125 бит), который показывается администратору один раз:
 *  - `enc` шифрует архив (AES-256-GCM), поэтому его можно передавать и по обычному HTTP, и на чужом носителе;
 *  - `auth` — доказательство знания кода для запросов к прежней панели. Сам код по сети не передаётся.
 * Модуль не обращается к БД: импорт выполняется до того, как панель откроет файл БД.
 */

export const ARCHIVE_MAGIC = Buffer.from('DMPANEL1');
export const ARCHIVE_FORMAT = 1;
/** Предел размера расшифрованного архива (защита от «бомбы»); БД панели занимает единицы мегабайт */
const MAX_PLAIN_BYTES = 1024 * 1024 * 1024;
/** Файлы, которые разрешено восстановить из архива (архив не может записать произвольный путь) */
/**
 * Имена в архиве — часть формата переноса между версиями: архив прежней панели (Demension) должен открываться новой.
 * Поэтому БД в архиве по-прежнему называется demension.db, а соль KDF не меняется.
 */
export const ARCHIVE_DB_ENTRY = 'demension.db';
export const ARCHIVE_FILES = [ARCHIVE_DB_ENTRY, 'secret.key', 'ssl/fullchain.pem', 'ssl/privkey.pem', 'ssl/acme-account.key'] as const;
export type ArchiveFileName = (typeof ARCHIVE_FILES)[number];

// Без похожих символов (O/0, I/1): код вводят вручную
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 25;
const KDF_SALT = Buffer.from('demension-panel-migration-v1');

export class MigrationArchiveError extends Error {}

/** На сервере уже есть панель с данными, а замена не разрешена (CLI завершается кодом 3, install.sh спрашивает подтверждение) */
export class ExistingDataError extends MigrationArchiveError {}

export interface MigrationManifest {
  format: number;
  panelVersion: string;
  /** Версия схемы БД (PRAGMA user_version) в архиве */
  dbVersion: number;
  createdAt: string;
  adminUsername: string | null;
  counts: { servers: number; remoteServers: number; clients: number; subscribers: number; partners: number; remotePanels: number };
  ssl: { enabled: boolean; mode: string | null; domain: string | null; expiresAt: string | null; hasFiles: boolean };
  /** Порт, на котором работала прежняя панель */
  port: number;
  publicUrl: string | null;
  cloudflareTokenSaved: boolean;
  sslEmail: string | null;
}

export interface ArchiveContent {
  manifest: MigrationManifest;
  files: Partial<Record<ArchiveFileName, Buffer>>;
}

/** Случайный код переноса вида XXXXX-XXXXX-XXXXX-XXXXX-XXXXX */
export function generateMigrationCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return raw.match(/.{5}/g)!.join('-');
}

/** Приводит введённый код к каноническому виду (без дефисов и пробелов, заглавными) или возвращает null */
export function normalizeMigrationCode(input: string): string | null {
  const raw = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!CODE_ALPHABET.includes(ch)) return null;
  return raw;
}

export function deriveMigrationKeys(code: string): { encKey: Buffer; auth: string } {
  const normalized = normalizeMigrationCode(code);
  if (!normalized) throw new MigrationArchiveError('Некорректный код переноса: ожидается 25 символов вида XXXXX-XXXXX-XXXXX-XXXXX-XXXXX');
  const ikm = Buffer.from(normalized, 'utf8');
  const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', ikm, KDF_SALT, info, 32));
  return { encKey: derive('enc'), auth: derive('auth').toString('hex') };
}

/** Значение для сравнения: на прежней панели хранится только SHA-256 доказательства */
export function hashAuth(auth: string): string {
  return crypto.createHash('sha256').update(auth).digest('hex');
}

export function sealArchive(content: ArchiveContent, encKey: Buffer): Buffer {
  const payload = {
    manifest: content.manifest,
    files: Object.fromEntries(Object.entries(content.files).map(([name, data]) => [name, (data as Buffer).toString('base64')])),
  };
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(ARCHIVE_MAGIC);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ARCHIVE_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

export function openArchive(archive: Buffer, encKey: Buffer): ArchiveContent {
  const headerLength = ARCHIVE_MAGIC.length + 12 + 16;
  if (archive.length <= headerLength || !archive.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
    throw new MigrationArchiveError('Это не архив переноса панели Dementia (или файл повреждён)');
  }
  let plain: Buffer;
  try {
    const iv = archive.subarray(ARCHIVE_MAGIC.length, ARCHIVE_MAGIC.length + 12);
    const tag = archive.subarray(ARCHIVE_MAGIC.length + 12, headerLength);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAAD(ARCHIVE_MAGIC);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(archive.subarray(headerLength)), decipher.final()]);
  } catch {
    throw new MigrationArchiveError('Не удалось расшифровать архив: неверный код переноса или файл повреждён');
  }

  let payload: any;
  try {
    payload = JSON.parse(zlib.gunzipSync(plain, { maxOutputLength: MAX_PLAIN_BYTES }).toString('utf8'));
  } catch {
    throw new MigrationArchiveError('Архив повреждён или слишком велик');
  }

  const manifest = payload?.manifest;
  if (!manifest || manifest.format !== ARCHIVE_FORMAT) {
    throw new MigrationArchiveError(`Неподдерживаемый формат архива (${manifest?.format ?? '?'}): обновите панель на этом сервере`);
  }
  const files: ArchiveContent['files'] = {};
  for (const [name, data] of Object.entries(payload.files ?? {})) {
    if (!(ARCHIVE_FILES as readonly string[]).includes(name) || typeof data !== 'string') {
      throw new MigrationArchiveError(`В архиве неожиданный файл: ${JSON.stringify(name).slice(0, 80)}`);
    }
    files[name as ArchiveFileName] = Buffer.from(data, 'base64');
  }
  if (!files[ARCHIVE_DB_ENTRY] || !files['secret.key']) {
    throw new MigrationArchiveError('В архиве нет базы данных или ключа шифрования');
  }
  return { manifest: manifest as MigrationManifest, files };
}
