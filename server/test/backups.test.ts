import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDatabase, setSetting } from '../src/db/index.js';
import { PanelArchiveService } from '../src/services/panel-archive.service.js';
import { BackupService } from '../src/services/backup.service.js';
import { GoogleDriveStorage, YandexDiskStorage } from '../src/services/backup-storage.js';
import { openArchive, sealArchive } from '../src/utils/migration-archive.js';

beforeAll(() => initDatabase());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ['migration_state', 'migration_expires_at', 'backup_last_run']) setSetting(key, null);
});

describe('архив резервной копии', () => {
  it('сохраняет данные без сессий и отклоняет неверный ключ', () => {
    db.prepare("INSERT INTO sessions(token, admin_id, expires_at) SELECT 'test-session', id, '2999-01-01' FROM admins LIMIT 1").run();
    const key = crypto.randomBytes(32);
    const archive = PanelArchiveService.create(key);
    const opened = openArchive(archive, key);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-backup-test-'));
    const file = path.join(dir, 'snapshot.db');
    fs.writeFileSync(file, opened.files['demension.db']!);
    const snapshot = new DatabaseSync(file, { readOnly: true });
    expect((snapshot.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
    snapshot.close();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(opened.files['secret.key']).toBeDefined();
    expect(opened.files['demension.db']!.length).toBeGreaterThan(1000);
    expect(() => openArchive(archive, crypto.randomBytes(32))).toThrow('неверный код');
    expect(archive.equals(sealArchive(opened, key))).toBe(false);
  });
});

describe('облачные хранилища', () => {
  it('Яндекс Диск использует WebDAV и Basic-авторизацию', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(new Response('', { status: 207 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = new YandexDiskStorage({ username: 'user', password: 'app-password' });
    await storage.test();
    expect(fetchMock.mock.calls[0][0]).toBe('https://webdav.yandex.ru/dementia-panel/');
    expect(fetchMock.mock.calls[0][1].method).toBe('MKCOL');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('user:app-password').toString('base64')}`);
  });

  it('Google Drive обновляет OAuth-токен и ограничивает список', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'file1', name: 'a.dpm', createdTime: '2026-01-01T00:00:00Z', size: '12' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = new GoogleDriveStorage({ client_id: 'client', client_secret: 'secret', refresh_token: 'refresh', folder_id: 'folder' });
    expect(await storage.list()).toEqual([]);
    const tokenRequest = fetchMock.mock.calls[0];
    expect(tokenRequest[0]).toBe('https://oauth2.googleapis.com/token');
    expect(String(tokenRequest[1].body)).toContain('refresh_token=refresh');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer access');
    expect(fetchMock.mock.calls[1][0]).toContain('pageSize=100');
  });
});

describe('расписание резервных копий', () => {
  it('не запускает параллельные копии и останавливается при переносе', async () => {
    let release: (() => void) | undefined;
    const create = vi.spyOn(PanelArchiveService, 'create').mockImplementation(() => new Promise<Buffer>((resolve) => { release = () => resolve(Buffer.from('archive')); }) as never);
    const storage = { upload: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]) };
    const getStorage = vi.spyOn(BackupService as any, 'getStorage').mockReturnValue(storage);
    setSetting('backup_enabled', '1');
    const first = BackupService.runNow();
    expect(await BackupService.runNow()).toEqual({ success: false, error: 'Резервное копирование уже выполняется' });
    release!();
    expect((await first).success).toBe(true);
    create.mockRestore(); getStorage.mockRestore();

    setSetting('migration_state', 'exporting');
    setSetting('migration_expires_at', new Date(Date.now() + 60000).toISOString());
    expect(await BackupService.runIfDue()).toBe(false);
  });

  it('удаляет только копии сверх лимита хранения', async () => {
    const storage = {
      list: vi.fn().mockResolvedValue([
        { id: 'new', name: 'new.dpm', created_at: '2026-03-01T00:00:00Z', size: 1 },
        { id: 'middle', name: 'middle.dpm', created_at: '2026-02-01T00:00:00Z', size: 1 },
        { id: 'old', name: 'old.dpm', created_at: '2026-01-01T00:00:00Z', size: 1 },
      ]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    await BackupService.prune(storage as never, 2);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith('old');
  });
});
