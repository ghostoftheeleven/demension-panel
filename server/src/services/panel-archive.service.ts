import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from '../config.js';
import { db, getSetting } from '../db/index.js';
import { ARCHIVE_DB_ENTRY, ARCHIVE_FORMAT, ArchiveContent, MigrationManifest, sealArchive } from '../utils/migration-archive.js';
import { exportSecretKey } from './secrets.service.js';
import { accountKeyPath, certPath, keyPath, SslService } from './ssl.service.js';
import { PANEL_VERSION } from './version.service.js';

export class PanelArchiveService {
  static create(recoveryKey: Buffer): Buffer {
    if (recoveryKey.length !== 32) throw new Error('Ключ резервной копии должен содержать 32 байта');
    return sealArchive(this.collect(), recoveryKey);
  }

  static collect(): ArchiveContent {
    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    const admin = db.prepare('SELECT username FROM admins ORDER BY id LIMIT 1').get() as { username: string } | undefined;
    const ssl = SslService.getStatus();
    const files: ArchiveContent['files'] = {
      [ARCHIVE_DB_ENTRY]: this.snapshotDatabase(),
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
      ssl: { enabled: ssl.enabled, mode: ssl.mode, domain: ssl.domain, expiresAt: ssl.expiresAt, hasFiles: Boolean(files['ssl/fullchain.pem'] && files['ssl/privkey.pem']) },
      port: Number(process.env.PORT) || 3001,
      publicUrl: getSetting('public_url'),
      cloudflareTokenSaved: Boolean(getSetting('cf_token')),
      sslEmail: getSetting('ssl_email'),
    };
    return { manifest, files };
  }

  private static snapshotDatabase(): Buffer {
    const tmp = path.join(dataDir, `backup-${crypto.randomBytes(6).toString('hex')}.tmp`);
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
}
