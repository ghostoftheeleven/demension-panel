import { describe, it, expect, beforeAll } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';

describe('Schema v11: 2FA и расширенная таблица сессий', () => {
  beforeAll(() => {
    initDatabase();
  });

  it('применяет миграцию v11 без ошибок', () => {
    // Проверяем колонки admins
    const adminColumns = db.prepare('PRAGMA table_info(admins)').all() as { name: string }[];
    const adminColNames = adminColumns.map((c) => c.name);
    expect(adminColNames).toContain('totp_secret');
    expect(adminColNames).toContain('totp_enabled');
    expect(adminColNames).toContain('recovery_codes');

    // Проверяем новую структуру sessions
    const sessColumns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const sessColNames = sessColumns.map((c) => c.name);
    expect(sessColNames).toContain('id');
    expect(sessColNames).toContain('token');
    expect(sessColNames).toContain('admin_id');
    expect(sessColNames).toContain('ip');
    expect(sessColNames).toContain('user_agent');
    expect(sessColNames).toContain('last_activity');
    expect(sessColNames).toContain('expires_at');
    expect(sessColNames).toContain('created_at');

    // Проверяем индексы
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_sessions_token');
    expect(indexNames).toContain('idx_sessions_admin_activity');
  });
});
