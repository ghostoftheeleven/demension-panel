import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import {
  compareVersions,
  PANEL_VERSION,
  parseLatestRedirect,
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

/** Ответ страницы /releases/latest (запасной путь); по умолчанию недоступна */
let page: { status: number; location?: string } | Error = new Error('page unavailable');

/** Подмена GitHub: ответы API по очереди (последний повторяется), страница релизов — по `page` */
function stubGithub(...responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const queue = [...responses];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === `https://github.com/${RELEASES_REPO}/releases/latest`) {
      if (page instanceof Error) throw page;
      return new Response(null, { status: page.status, headers: page.location ? { location: page.location } : {} });
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { 'Content-Type': 'application/json', ...next.headers } });
  });
}

const apiCalls = (fetch: ReturnType<typeof stubGithub>) => fetch.mock.calls.filter(([input]) => String(input).startsWith('https://api.github.com/')).length;

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
    delete process.env.DEMENTIA_UPDATE_CHECK;
    page = new Error('page unavailable');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.DEMENTIA_UPDATE_CHECK;
  });

  it('новый релиз на GitHub — доступно обновление', async () => {
    const newer = bump(PANEL_VERSION, 2);
    const fetch = stubGithub({ status: 200, body: release(newer) });

    const info = await VersionService.getInfo();

    expect(info).toMatchObject({ current: PANEL_VERSION, latest: newer, update_available: true, error: null, check_enabled: true });
    expect(String(fetch.mock.calls[0][0])).toBe(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`);
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'User-Agent': `dementia-panel/${PANEL_VERSION}` });
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

  it('принудительная проверка (кнопка в интерфейсе) — не чаще раза в 15 секунд', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetch = stubGithub({ status: 200, body: release(PANEL_VERSION) });
    await VersionService.getInfo();
    await VersionService.getInfo(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 16 * 1000);
    await VersionService.getInfo(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('API отказал (исчерпан лимит 60 запросов в час) — версия берётся по перенаправлению страницы релизов', async () => {
    const newer = bump(PANEL_VERSION, 2);
    page = { status: 302, location: `https://github.com/${RELEASES_REPO}/releases/tag/${newer}` };
    const fetch = stubGithub({ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } });
    const info = await VersionService.getInfo();
    expect(info).toMatchObject({ latest: newer, update_available: true, error: null, latest_url: `https://github.com/${RELEASES_REPO}/releases/tag/${newer}` });
    const pageCall = fetch.mock.calls.find(([input]) => String(input).endsWith('/releases/latest') && !String(input).includes('api.github.com'))!;
    expect(pageCall[1]).toMatchObject({ method: 'HEAD', redirect: 'manual' });
  });

  it('недоступны и API, и страница — понятная ошибка; чужое перенаправление не принимается', async () => {
    stubGithub({ status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0' } });
    expect((await VersionService.getInfo()).error).toBe('Не удалось проверить обновления: GitHub ограничил число запросов с адреса сервера (60 в час)');

    vi.restoreAllMocks();
    VersionService.resetCache();
    page = { status: 302, location: 'https://evil.example/releases/tag/v99.0.0' };
    stubGithub({ status: 500 });
    expect(await VersionService.getInfo()).toMatchObject({ latest: null, error: 'Не удалось проверить обновления: GitHub ответил HTTP 500' });

    expect(parseLatestRedirect(`https://github.com/${RELEASES_REPO}/releases/tag/v1.2.3`)).toMatchObject({ version: 'v1.2.3', published_at: null });
    expect(parseLatestRedirect(`https://github.com/${RELEASES_REPO}/releases/tag/v1.2.3"><script>`)).toBeNull();
    expect(parseLatestRedirect(`https://github.com/other/repo/releases/tag/v1.2.3`)).toBeNull();
    expect(parseLatestRedirect(null)).toBeNull();
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
    expect(apiCalls(fetch)).toBe(2);
    vi.setSystemTime(Date.now() + 21 * 60 * 1000);
    expect((await VersionService.getInfo()).error).toBeNull();
    expect(apiCalls(fetch)).toBe(3);
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

  it('DEMENTIA_UPDATE_CHECK=0 — панель не обращается к GitHub', async () => {
    process.env.DEMENTIA_UPDATE_CHECK = '0';
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
