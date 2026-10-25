import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import { MigrationService } from '../src/services/migration.service.js';
import { installDir, UpdateService, updateStateDir } from '../src/services/update.service.js';
import { PANEL_VERSION, parseVersion, RELEASES_REPO, VersionService } from '../src/services/version.service.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer } from './test-app.js';

/**
 * Обновление панели из интерфейса: API /api/version/update и UpdateService. Сам запуск (systemd-run) подменяется,
 * скрипт обновления проверяется отдельно — update-panel-script.test.ts.
 */

const newer = (() => {
  const p = parseVersion(PANEL_VERSION)!;
  return `v${p[0]}.${p[1]}.${p[2] + 1}`;
})();

function stubGithub(tag: string) {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).startsWith('https://api.github.com/')) {
      const body = { tag_name: tag, html_url: `https://github.com/${RELEASES_REPO}/releases/tag/${tag}`, published_at: '2026-10-25T10:00:00Z' };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return realFetch(input, init);
  });
}

const statusFile = () => path.join(updateStateDir, 'status.json');
const writeStatus = (status: unknown) => {
  fs.mkdirSync(updateStateDir, { recursive: true });
  fs.writeFileSync(statusFile(), typeof status === 'string' ? status : JSON.stringify(status));
};

describe('обновление панели из интерфейса (/api/version/update)', () => {
  let env: Awaited<ReturnType<typeof startTestServer>>;
  let admin: ReturnType<typeof createAdminApi>;

  beforeAll(async () => {
    initDatabase();
    env = await startTestServer();
    admin = createAdminApi(env, 'admin_update');
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(() => {
    VersionService.resetCache();
    fs.rmSync(updateStateDir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEMENSION_SELF_UPDATE;
  });

  it('только для администратора', async () => {
    expect((await env.request('/api/version/update')).status).toBe(401);
    expect((await env.request('/api/version/update', { method: 'POST' })).status).toBe(401);
  });

  it('без установки install.sh (не служба systemd) обновление недоступно и объясняется почему', async () => {
    const saved = process.env.INVOCATION_ID;
    delete process.env.INVOCATION_ID;
    try {
      const launch = vi.spyOn(UpdateService, 'launch').mockResolvedValue();
      const status = await admin.api('/api/version/update');
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ available: false, current: PANEL_VERSION, state: 'idle', log: '' });
      expect(status.body.reason).toMatch(/терминал|install.sh/);

      const res = await admin.api('/api/version/update', 'POST', { version: newer });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(status.body.reason);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.INVOCATION_ID = saved;
    }
  });

  it('DEMENSION_SELF_UPDATE=0 отключает обновление из панели', () => {
    process.env.DEMENSION_SELF_UPDATE = '0';
    expect(UpdateService.environmentProblem()).toMatch(/DEMENSION_SELF_UPDATE=0/);
  });

  it('запускает обновление до последнего релиза отдельной службой и показывает, что оно идёт', async () => {
    vi.spyOn(UpdateService, 'environmentProblem').mockReturnValue(null);
    const launch = vi.spyOn(UpdateService, 'launch').mockResolvedValue();
    stubGithub(newer);

    const res = await admin.api('/api/version/update', 'POST', { version: newer });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, state: 'running', from: PANEL_VERSION, to: newer, finished_at: null });

    expect(launch).toHaveBeenCalledTimes(1);
    const [runner, dir, stateDir, target, from] = launch.mock.calls[0][0];
    expect([dir, stateDir, target, from]).toEqual([installDir, updateStateDir, newer, PANEL_VERSION]);
    // Скрипт запускается из копии в каталоге данных: git и сборка заменяют файлы панели во время обновления
    expect(runner).toBe(path.join(updateStateDir, 'update-panel.sh'));
    expect(fs.readFileSync(runner, 'utf-8')).toContain('PANEL_UPDATE_REF');

    // Второй запуск, пока идёт первый, отклоняется
    const again = await admin.api('/api/version/update', 'POST', { version: newer });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('уже выполняется');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('установлена последняя версия — обновлять нечего', async () => {
    vi.spyOn(UpdateService, 'environmentProblem').mockReturnValue(null);
    const launch = vi.spyOn(UpdateService, 'launch').mockResolvedValue();
    stubGithub(PANEL_VERSION);
    const res = await admin.api('/api/version/update', 'POST', { version: PANEL_VERSION });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('последняя версия');
    expect(launch).not.toHaveBeenCalled();
  });

  it('обновиться можно только на последний релиз, который видит панель', async () => {
    vi.spyOn(UpdateService, 'environmentProblem').mockReturnValue(null);
    const launch = vi.spyOn(UpdateService, 'launch').mockResolvedValue();
    stubGithub(newer);
    for (const version of ['v99.0.0', 'main', '; rm -rf /', undefined]) {
      const res = await admin.api('/api/version/update', 'POST', { version });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain(newer);
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('проверка обновлений отключена — обновление из панели не запускается', async () => {
    vi.spyOn(UpdateService, 'environmentProblem').mockReturnValue(null);
    const launch = vi.spyOn(UpdateService, 'launch').mockResolvedValue();
    process.env.DEMENSION_UPDATE_CHECK = '0';
    try {
      const res = await admin.api('/api/version/update', 'POST', { version: newer });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('DEMENSION_UPDATE_CHECK=0');
      expect(launch).not.toHaveBeenCalled();
    } finally {
      delete process.env.DEMENSION_UPDATE_CHECK;
    }
  });

  it('ошибка запуска systemd-run — состояние «не удалось», панель продолжает работать', async () => {
    vi.spyOn(UpdateService, 'environmentProblem').mockReturnValue(null);
    vi.spyOn(UpdateService, 'launch').mockRejectedValue(Object.assign(new Error('fail'), { stderr: 'Failed to start transient service unit\nmore' }));
    stubGithub(newer);

    const res = await admin.api('/api/version/update', 'POST', { version: newer });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Не удалось запустить обновление: Failed to start transient service unit');
    const status = await admin.api('/api/version/update');
    expect(status.body).toMatchObject({ state: 'failed', to: newer });
    expect(status.body.finished_at).not.toBeNull();
  });

  it('во время переноса панели обновление не запускается', async () => {
    vi.spyOn(UpdateService, 'environmentProblem').mockReturnValue(null);
    const launch = vi.spyOn(UpdateService, 'launch').mockResolvedValue();
    vi.spyOn(MigrationService, 'getState').mockReturnValue('exporting');
    stubGithub(newer);
    const res = await admin.api('/api/version/update', 'POST', { version: newer });
    expect(res.status).toBe(423);
    expect(launch).not.toHaveBeenCalled();
  });

  it('файл состояния разбирается строго; зависшее обновление считается прерванным', async () => {
    writeStatus('не json');
    expect(UpdateService.getStatus()).toMatchObject({ state: 'idle', from: null, to: null });

    writeStatus({ state: 'hacked', to: newer });
    expect(UpdateService.getStatus().state).toBe('idle');

    writeStatus({ state: 'rolled_back', from: PANEL_VERSION, to: 'v1.2.3"<b>', started_at: 'вчера', finished_at: '2026-10-25T10:00:00Z', message: 'строка\nвторая\u001b[31m' });
    expect(UpdateService.getStatus()).toMatchObject({
      state: 'rolled_back', from: PANEL_VERSION, to: null, started_at: null, finished_at: '2026-10-25T10:00:00.000Z', message: 'строка вторая [31m',
    });

    writeStatus({ state: 'running', from: PANEL_VERSION, to: newer, started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const stale = UpdateService.getStatus();
    expect(stale.state).toBe('failed');
    expect(stale.message).toContain('прервано');

    writeStatus({ state: 'running', from: PANEL_VERSION, to: newer, started_at: new Date().toISOString() });
    expect(UpdateService.getStatus().state).toBe('running');
  });

  it('журнал обновления отдаётся без цветовых кодов терминала и только последними строками', async () => {
    fs.mkdirSync(updateStateDir, { recursive: true });
    const lines = Array.from({ length: 500 }, (_, i) => `\x1b[0;32mстрока ${i}\x1b[0m`);
    fs.writeFileSync(path.join(updateStateDir, 'update.log'), lines.join('\n') + '\n');
    const { log } = (await admin.api('/api/version/update')).body;
    const out = log.split('\n');
    expect(out).toHaveLength(300);
    expect(out[0]).toBe('строка 200');
    expect(out.at(-1)).toBe('строка 499');
    expect(log).not.toContain('\x1b');
  });
});
