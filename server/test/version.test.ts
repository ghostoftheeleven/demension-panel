import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import {
  compareVersions,
  PANEL_VERSION,
  parseLatestRelease,
  parseVersion,
  RELEASES_REPO,
  VersionService,
} from '../src/services/version.service.js';
import { createAdminApi } from './helpers/api.js';
import { startTestServer } from './test-app.js';

/**
 * Версия панели (корневой package.json), согласованность с CHANGELOG.md (из него берётся текст релиза GitHub)
 * и проверка последнего релиза через GitHub API — без сети: fetch подменяется.
 */

const root = path.resolve(__dirname, '../..');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/${RELEASES_REPO}/releases/tag/${tag}`,
  published_at: '2026-10-24T12:00:00Z',
  ...extra,
});

function stubGithub(...responses: Array<{ status: number; body?: unknown } | Error>) {
  const queue = [...responses];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'Content-Type': 'application/json' } });
  });
}

const bump = (version: string, part: 0 | 1 | 2) => {
  const p = parseVersion(version)!;
  p[part]++;
  for (let i = part + 1; i < 3; i++) p[i] = 0;
  return `v${p.join('.')}`;
};

describe('номер версии и история изменений', () => {
  it('версия панели берётся из корневого package.json в формате vX.Y.Z', () => {
    expect(rootPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PANEL_VERSION).toBe(`v${rootPackage.version}`);
  });

  it('первый раздел CHANGELOG.md — текущая версия, с описанием (без него релиз не опубликуется)', () => {
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');
    const sections = [...changelog.matchAll(/^## (v\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]);
    expect(sections[0]).toBe(PANEL_VERSION);
    const body = changelog.split(/^## v\d+\.\d+\.\d+.*$/m)[1] ?? '';
    expect(body.trim().length).toBeGreaterThan(20);
    // Версии в истории идут по убыванию
    for (let i = 1; i < sections.length; i++) expect(compareVersions(sections[i - 1], sections[i])).toBeGreaterThan(0);
  });

  it('сравнение версий: по числам, а не по строкам', () => {
    expect(compareVersions('v0.10.0', 'v0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', 'v0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('v0.1.2', 'v0.1.10')).toBeLessThan(0);
    expect(compareVersions('0.1.0', 'v0.1.0')).toBe(0);
    expect(parseVersion('v1.2')).toBeNull();
    expect(parseVersion('v1.2.3-beta')).toBeNull();
  });

  it('ответ GitHub проверяется по формату: чужие ссылки и теги не принимаются', () => {
    expect(parseLatestRelease(release('v0.2.0'))).toMatchObject({ version: 'v0.2.0', published_at: '2026-10-24T12:00:00.000Z' });
    expect(parseLatestRelease(release('latest'))).toBeNull();
    expect(parseLatestRelease(release('v0.2.0\n<script>'))).toBeNull();
    expect(parseLatestRelease(release('v0.2.0', { html_url: 'https://evil.example/phish' }))!.url).toBe(
      `https://github.com/${RELEASES_REPO}/releases/tag/v0.2.0`
    );
    expect(parseLatestRelease(release('v0.2.0', { html_url: `https://github.com/${RELEASES_REPO}/releases/x"onclick` }))!.url).toBe(
      `https://github.com/${RELEASES_REPO}/releases/tag/v0.2.0`
    );
    expect(parseLatestRelease(release('v0.2.0', { published_at: 'вчера' }))!.published_at).toBeNull();
  });
});

describe('проверка последнего релиза (VersionService)', () => {
  beforeEach(() => {
    VersionService.resetCache();
    delete process.env.DEMENSION_UPDATE_CHECK;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.DEMENSION_UPDATE_CHECK;
  });

  it('новый релиз на GitHub — доступно обновление', async () => {
    const newer = bump(PANEL_VERSION, 2);
    const fetch = stubGithub({ status: 200, body: release(newer) });

    const info = await VersionService.getInfo();

    expect(info).toMatchObject({ current: PANEL_VERSION, latest: newer, update_available: true, error: null, check_enabled: true });
    expect(String(fetch.mock.calls[0][0])).toBe(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`);
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'User-Agent': `demension-panel/${PANEL_VERSION}` });
  });

  it('та же или более старая версия — обновления нет', async () => {
    stubGithub({ status: 200, body: release(PANEL_VERSION) });
    expect(await VersionService.getInfo()).toMatchObject({ latest: PANEL_VERSION, update_available: false });
  });

  it('ответ кэшируется: повторные и одновременные запросы не обращаются к GitHub', async () => {
    const fetch = stubGithub({ status: 200, body: release(PANEL_VERSION) });
    await Promise.all([VersionService.getInfo(), VersionService.getInfo(), VersionService.getInfo()]);
    await VersionService.getInfo();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('принудительная проверка — не чаще раза в минуту', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetch = stubGithub({ status: 200, body: release(PANEL_VERSION) });
    await VersionService.getInfo();
    await VersionService.getInfo(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61 * 1000);
    await VersionService.getInfo(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ошибка сети: сообщение, последняя известная версия сохраняется, повтор через 30 минут', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const newer = bump(PANEL_VERSION, 1);
    const fetch = stubGithub({ status: 200, body: release(newer) }, new Error('getaddrinfo ENOTFOUND api.github.com'), {
      status: 200,
      body: release(newer),
    });
    await VersionService.getInfo();

    vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
    const failed = await VersionService.getInfo();
    expect(failed).toMatchObject({ latest: newer, update_available: true });
    expect(failed.error).toContain('ENOTFOUND');

    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    await VersionService.getInfo();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 21 * 60 * 1000);
    expect((await VersionService.getInfo()).error).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('релизов ещё нет (404) и некорректный тег', async () => {
    stubGithub({ status: 404, body: { message: 'Not Found' } });
    expect(await VersionService.getInfo()).toMatchObject({ latest: null, update_available: false, error: 'Релизы на GitHub ещё не опубликованы' });

    vi.restoreAllMocks();
    VersionService.resetCache();
    stubGithub({ status: 200, body: release('nightly') });
    const info = await VersionService.getInfo();
    expect(info.latest).toBeNull();
    expect(info.error).toContain('vX.Y.Z');
  });

  it('DEMENSION_UPDATE_CHECK=0 — панель не обращается к GitHub', async () => {
    process.env.DEMENSION_UPDATE_CHECK = '0';
    const fetch = stubGithub({ status: 200, body: release('v99.0.0') });
    expect(await VersionService.getInfo(true)).toMatchObject({ current: PANEL_VERSION, latest: null, check_enabled: false, update_available: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('GET /api/version', () => {
  let env: Awaited<ReturnType<typeof startTestServer>>;
  let admin: ReturnType<typeof createAdminApi>;

  beforeAll(async () => {
    initDatabase();
    env = await startTestServer();
    admin = createAdminApi(env, 'admin_version');
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(() => VersionService.resetCache());
  afterEach(() => vi.restoreAllMocks());

  it('только для администратора', async () => {
    expect((await env.request('/api/version')).status).toBe(401);
  });

  it('возвращает текущую и последнюю версию из кэша', async () => {
    const newer = bump(PANEL_VERSION, 0);
    const realFetch = globalThis.fetch;
    // Запросы теста к самой панели идут настоящим fetch, к GitHub — подменённым
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify(release(newer)), { status: 200 });
      }
      return realFetch(input, init);
    });
    const githubCalls = () => fetch.mock.calls.filter(([input]) => String(input).startsWith('https://api.github.com/')).length;

    const res = await admin.api('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ current: PANEL_VERSION, latest: newer, update_available: true });
    expect(githubCalls()).toBe(1);

    await admin.api('/api/version');
    expect(githubCalls()).toBe(1);
  });
});
