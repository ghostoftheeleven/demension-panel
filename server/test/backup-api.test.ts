import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetting, initDatabase, setSetting } from '../src/db/index.js';
import { isEncrypted } from '../src/services/secrets.service.js';
import { BackupService } from '../src/services/backup.service.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer, TestEnv } from './test-app.js';

let env: TestEnv;
let admin: ReturnType<typeof createAdminApi>;
beforeAll(async () => {
  initDatabase();
  env = await startTestServer();
  admin = createAdminApi(env, 'backupadmin');
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ['backup_enabled', 'backup_provider', 'backup_yandex_username', 'backup_yandex_password', 'backup_google_client_id', 'backup_google_client_secret', 'backup_google_refresh_token', 'backup_recovery_key']) setSetting(key, null);
});

describe('API резервных копий', () => {
  it('шифрует облачные секреты и не возвращает их', async () => {
    const response = await admin.api('/api/backups/settings', 'PUT', {
      enabled: true, provider: 'yandex', interval_hours: 24, retention: 10,
      yandex_username: 'user', yandex_password: 'app-secret',
    });
    expect(response.status).toBe(200);
    expect(response.body.settings).toMatchObject({ enabled: true, provider: 'yandex', yandex_password_saved: true });
    expect(JSON.stringify(response.body)).not.toContain('app-secret');
    expect(isEncrypted(getSetting('backup_yandex_password'))).toBe(true);
  });

  it('показывает ключ восстановления только после правильного пароля', async () => {
    expect((await admin.api('/api/backups/recovery-key', 'POST', { password: 'wrong' })).status).toBe(400);
    const response = await admin.api('/api/backups/recovery-key', 'POST', { password: 'TestPassword123!' });
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body.recovery_key, 'base64')).toHaveLength(32);
    expect(isEncrypted(getSetting('backup_recovery_key'))).toBe(true);
  });

  it('возвращает список удалённых копий и запускает создание', async () => {
    vi.spyOn(BackupService, 'list').mockResolvedValue([{ id: 'one', name: 'one.dpm', created_at: '2026-01-01T00:00:00Z', size: 10 }]);
    const list = await admin.api('/api/backups');
    expect(list.body.backups[0].name).toBe('one.dpm');
    vi.spyOn(BackupService, 'runNow').mockResolvedValue({ success: true });
    expect((await admin.api('/api/backups/run', 'POST')).body.success).toBe(true);
  });
});
