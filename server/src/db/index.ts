import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'demension.db');
export const db = new DatabaseSync(dbPath);

// Enable WAL mode for better concurrency and performance
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      traffic_limit INTEGER NOT NULL DEFAULT 0,
      expire_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      ssh_port INTEGER NOT NULL DEFAULT 22,
      ssh_user TEXT NOT NULL DEFAULT 'root',
      ssh_password TEXT,
      ssh_key TEXT,
      awg_port INTEGER NOT NULL DEFAULT 51820,
      subnet TEXT NOT NULL DEFAULT '10.8.0.1/24',
      server_public_key TEXT,
      server_private_key TEXT,
      preshared_key TEXT,
      jc INTEGER NOT NULL DEFAULT 4,
      jmin INTEGER NOT NULL DEFAULT 40,
      jmax INTEGER NOT NULL DEFAULT 70,
      s1 INTEGER NOT NULL DEFAULT 36,
      s2 INTEGER NOT NULL DEFAULT 124,
      h1 INTEGER NOT NULL DEFAULT 124357689,
      h2 INTEGER NOT NULL DEFAULT 987654321,
      h3 INTEGER NOT NULL DEFAULT 135792468,
      h4 INTEGER NOT NULL DEFAULT 246813579,
      status TEXT NOT NULL DEFAULT 'uninstalled',
      last_seen TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      subscriber_id INTEGER,
      name TEXT NOT NULL,
      client_ip TEXT NOT NULL,
      client_public_key TEXT NOT NULL,
      client_private_key TEXT NOT NULL,
      preshared_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      total_rx INTEGER NOT NULL DEFAULT 0,
      total_tx INTEGER NOT NULL DEFAULT 0,
      last_handshake TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Ensure subscriber_id exists if clients table was previously created without it
  try {
    db.exec('ALTER TABLE clients ADD COLUMN subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE;');
  } catch {
    // Column already exists
  }
}
