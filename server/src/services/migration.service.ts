import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from '../config.js';
import { db, getSetting, setSetting } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import {
  ARCHIVE_FORMAT,
  ArchiveContent,
  MigrationManifest,
  deriveMigrationKeys,
  generateMigrationCode,
  hashAuth,
  sealArchive,
} from '../utils/migration-archive.js';
import { decryptSecret, encryptSecret, exportSecretKey } from './secrets.service.js';
import { SslService, accountKeyPath, certPath, keyPath } from './ssl.service.js';
import { PANEL_VERSION } from './version.service.js';

/**
 * Перенос панели на другой сервер — сторона прежней (отдающей) панели.
 *
 *   idle      — обычная работа
 *   prepared  — выдан код переноса (час): архив ещё не забирали
 *   exporting — архив забрали: изменения в панели блокируются (иначе они потеряются), фоновые задачи на паузе;
 *               состояние снимается завершением переноса, отменой или само через EXPORT_LOCK_MS
 *   migrated  — новая панель запущена: эта панель заморожена, ссылки подписок перенаправляются на новый адрес
 *
 * В settings хранится только производное от кода: ключ шифрования архива (зашифрован мастер-ключом) и SHA-256
 * доказательства знания кода. Сам код показывается администратору один раз.
 */

export type MigrationState = 'idle' | 'prepared' | 'exporting' | 'migrated';

/** Сколько действует выданный код, пока архив не забрали */
export const PREPARED_TTL_MS = 60 * 60 * 1000;
/** Сколько после выдачи архива панель ждёт завершения переноса, прежде чем снять блокировку изменений */
export const EXPORT_LOCK_MS = 2 * 60 * 60 * 1000;

const KEYS = [
  'migration_state',
  'migration_key',
  'migration_auth_hash',
  'migration_expires_at',
  'migration_exported_at',
  'migration_migrated_at',
  'migration_new_url',
] as const;

function clearMigrationSettings(): void {
  for (const key of KEYS) setSetting(key, null);
}

export interface MigrationStatus {
  state: MigrationState;
  /** До какого момента действует код (prepared) или блокировка изменений (exporting) */
  expiresAt: string | null;
  exportedAt: string | null;
  migratedAt: string | null;
  newUrl: string | null;
}

export class MigrationService {
  /** Текущее состояние; просроченные prepared/exporting сбрасываются в idle */
  static getState(): MigrationState {
    const state = getSetting('migration_state');
    if (state === 'migrated') return 'migrated';
    if (state === 'prepared' || state === 'exporting') {
      const expires = new Date(getSetting('migration_expires_at') ?? 0).getTime();
      if (!(expires > Date.now())) {
        clearMigrationSettings();
        return 'idle';
      }
      return state;
    }
    return 'idle';
  }

  static getStatus(): MigrationStatus {
    const state = this.getState();
    return {
      state,
      expiresAt: state === 'prepared' || state === 'exporting' ? getSetting('migration_expires_at') : null,
      exportedAt: getSetting('migration_exported_at'),
      migratedAt: getSetting('migration_migrated_at'),
      newUrl: getSetting('migration_new_url'),
    };
  }

  /** Фоновые задачи (опрос нод, партнёры, продление сертификата) не должны работать, пока ноды переходят к другой панели */
  static isBackgroundPaused(): boolean {
    const state = this.getState();
    return state === 'exporting' || state === 'migrated';
  }

  /** Выдаёт код переноса. Предыдущий код и неотданный архив аннулируются */
  static prepare(): { code: string; expiresAt: string } {
    const state = this.getState();
    if (state === 'migrated') throw new HttpError(409, 'Эта панель уже перенесена на другой сервер');
    if (state === 'exporting') throw new HttpError(409, 'Архив уже передан на новый сервер: завершите или отмените текущий перенос');

    const code = generateMigrationCode();
    const { encKey, auth } = deriveMigrationKeys(code);
    const expiresAt = new Date(Date.now() + PREPARED_TTL_MS).toISOString();
    setSetting('migration_state', 'prepared');
    setSetting('migration_key', encryptSecret(encKey.toString('base64')));
    setSetting('migration_auth_hash', hashAuth(auth));
    setSetting('migration_expires_at', expiresAt);
    setSetting('migration_exported_at', null);
    return { code, expiresAt };
  }

  /** Отмена переноса (или снятие блокировки после неудачи); замороженную панель возвращает к работе */
  static cancel(): void {
    clearMigrationSettings();
  }

  /** Проверяет доказательство знания кода (заголовок X-Migration-Auth) */
  static verifyAuth(auth: string): boolean {
    const state = this.getState();
    if (state !== 'prepared' && state !== 'exporting') return false;
    const stored = getSetting('migration_auth_hash');
    if (!stored) return false;
    const a = Buffer.from(hashAuth(auth), 'hex');
    const b = Buffer.from(stored, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Консистентная копия БД без сессий и служебных данных переноса */
  private static snapshotDatabase(): Buffer {
    const tmp = path.join(dataDir, `migration-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const snapshot = new DatabaseSync(tmp);
      try {
        snapshot.exec("DELETE FROM sessions; DELETE FROM settings WHERE key LIKE 'migration\\_%' ESCAPE '\\'");
      } finally {
        snapshot.close();
      }
      return fs.readFileSync(tmp);
    } finally {
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(tmp + suffix, { force: true });
    }
  }

  private static collect(): ArchiveContent {
    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    const admin = db.prepare('SELECT username FROM admins ORDER BY id LIMIT 1').get() as { username: string } | undefined;
    const ssl = SslService.getStatus();

    const files: ArchiveContent['files'] = {
      'demension.db': this.snapshotDatabase(),
      'secret.key': Buffer.from(exportSecretKey() + '\n'),
    };
    if (SslService.hasCertificate()) {
      files['ssl/fullchain.pem'] = fs.readFileSync(certPath);
      files['ssl/privkey.pem'] = fs.readFileSync(keyPath);
    }
    if (fs.existsSync(accountKeyPath)) files['ssl/acme-account.key'] = fs.readFileSync(accountKeyPath);

    const manifest: MigrationManifest = {
      format: ARCHIVE_FORMAT,
      panelVersion: PANEL_VERSION,
      dbVersion: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      createdAt: new Date().toISOString(),
      adminUsername: admin?.username ?? null,
      counts: {
        servers: count('SELECT COUNT(*) AS c FROM servers WHERE remote_panel_id IS NULL'),
        remoteServers: count('SELECT COUNT(*) AS c FROM servers WHERE remote_panel_id IS NOT NULL'),
        clients: count('SELECT COUNT(*) AS c FROM clients'),
        subscribers: count('SELECT COUNT(*) AS c FROM subscribers'),
        partners: count('SELECT COUNT(*) AS c FROM partners'),
        remotePanels: count('SELECT COUNT(*) AS c FROM remote_panels'),
      },
      ssl: {
        enabled: ssl.enabled,
        mode: ssl.mode,
        domain: ssl.domain,
        expiresAt: ssl.expiresAt,
        hasFiles: Boolean(files['ssl/fullchain.pem'] && files['ssl/privkey.pem']),
      },
      port: Number(process.env.PORT) || 3001,
      publicUrl: getSetting('public_url'),
      cloudflareTokenSaved: Boolean(getSetting('cf_token')),
      sslEmail: getSetting('ssl_email'),
    };
    return { manifest, files };
  }

  /**
   * Собирает свежий архив. С этого момента панель в состоянии exporting: изменения, сделанные после снимка, на новый сервер
   * не попали бы, поэтому API их не принимает.
   */
  static buildArchive(): Buffer {
    const state = this.getState();
    if (state !== 'prepared' && state !== 'exporting') {
      throw new HttpError(409, 'Перенос не подготовлен: сначала получите код переноса');
    }
    const key = Buffer.from(decryptSecret(getSetting('migration_key')) ?? '', 'base64');
    if (key.length !== 32) throw new HttpError(500, 'Ключ переноса повреждён: подготовьте перенос заново');

    const sealed = sealArchive(this.collect(), key);

    setSetting('migration_state', 'exporting');
    setSetting('migration_exported_at', new Date().toISOString());
    setSetting('migration_expires_at', new Date(Date.now() + EXPORT_LOCK_MS).toISOString());
    return sealed;
  }

  /** Новая панель запущена: прежняя замораживается, а её ссылки подписок перенаправляются на новый адрес */
  static finish(newUrl: string | null): void {
    if (this.getState() !== 'exporting') throw new HttpError(409, 'Архив переноса не передавался на новый сервер');

    let origin: string | null = null;
    if (newUrl) {
      try {
        const url = new URL(newUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin;
      } catch {
        // некорректный адрес — перенаправления не будет
      }
    }
    setSetting('migration_state', 'migrated');
    setSetting('migration_migrated_at', new Date().toISOString());
    setSetting('migration_new_url', origin);
    setSetting('migration_key', null);
    setSetting('migration_auth_hash', null);
    setSetting('migration_expires_at', null);
    db.exec('DELETE FROM sessions');
  }
}
