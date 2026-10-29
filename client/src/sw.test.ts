// @vitest-environment node
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * Сервис-воркер (public/sw.js) выполняется в песочнице с поддельными кешем и сетью. Главное, что здесь проверяется: данные панели
 * (/api, /sub, /ws, ответы на запросы с токеном) воркер не трогает и не кеширует никогда — в них токены и приватные ключи.
 */

const ORIGIN = 'https://panel.test';
const code = fs.readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

class FakeCache {
  store = new Map<string, Response>();
  private key = (request: string | { url: string }) => (typeof request === 'string' ? new URL(request, ORIGIN).href : request.url);
  async match(request: string | { url: string }) {
    return this.store.get(this.key(request))?.clone();
  }
  async put(request: string | { url: string }, response: Response) {
    this.store.set(this.key(request), response);
  }
  async add(request: string) {
    const response = await network(request);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    this.store.set(this.key(request), response);
  }
  async keys() {
    return [...this.store.keys()].map((url) => ({ url }));
  }
  async delete(request: { url: string }) {
    return this.store.delete(request.url);
  }
}

class FakeCaches {
  map = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return this.map.get(name)!;
  }
  async keys() {
    return [...this.map.keys()];
  }
  async delete(name: string) {
    return this.map.delete(name);
  }
}

let caches: FakeCaches;
let network: Mock<(request: any) => Promise<Response>>;
let listeners: Record<string, (event: any) => void>;
let self: any;

beforeEach(() => {
  caches = new FakeCaches();
  network = vi.fn(async (request: string | { url: string }) => {
    const url = typeof request === 'string' ? request : request.url;
    return new Response(`net:${url}`, { status: 200, headers: { 'Content-Type': url.endsWith('.js') ? 'text/javascript' : url.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html; charset=utf-8' } });
  });
  listeners = {};
  self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: any) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
  };
  vm.runInNewContext(code, { self, caches, fetch: (request: unknown) => network(request), Response, Headers, URL, Promise, setTimeout, clearTimeout });
});

const req = (path: string, init: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {}) => ({
  url: `${init.origin ?? ORIGIN}${path}`,
  method: init.method ?? 'GET',
  mode: init.mode ?? 'cors',
  headers: new Headers(init.headers),
});

async function dispatch(request: ReturnType<typeof req>): Promise<Response | null> {
  let answer: Promise<Response> | null = null;
  listeners.fetch({ request, respondWith: (p: Promise<Response>) => (answer = Promise.resolve(p)) });
  return answer ? await answer : null;
}

const allCached = () => [...caches.map.values()].flatMap((c) => [...c.store.keys()]);

describe('данные панели воркер не трогает и не кеширует', () => {
  it.each(['/api/servers', '/api/auth/me', '/api/servers/1/clients/5/config', '/sub/abcdef', '/sub/abcdef?format=json', '/ws', '/.well-known/acme-challenge/x'])(
    '%s — запрос идёт в сеть как есть',
    async (path) => {
      expect(await dispatch(req(path))).toBeNull();
      expect(await dispatch(req(path, { mode: 'navigate' }))).toBeNull();
      expect(network).not.toHaveBeenCalled();
      expect(allCached()).toEqual([]);
    }
  );

  it('запрос с токеном (Authorization) не обрабатывается даже за пределами /api', async () => {
    expect(await dispatch(req('/assets/app.js', { headers: { Authorization: 'Bearer secret' } }))).toBeNull();
    expect(allCached()).toEqual([]);
  });

  it('записи (POST и др.) и чужие источники не обрабатываются', async () => {
    expect(await dispatch(req('/assets/app.js', { method: 'POST' }))).toBeNull();
    expect(await dispatch(req('/assets/app.js', { origin: 'https://evil.example' }))).toBeNull();
  });

  it('неизвестные пути вне интерфейса остаются нетронутыми', async () => {
    expect(await dispatch(req('/some/other.json'))).toBeNull();
  });
});

describe('оболочка (навигация): сеть, затем запасной кеш', () => {
  it('при связи отдаёт ответ сервера и сохраняет оболочку', async () => {
    const response = await dispatch(req('/', { mode: 'navigate' }));
    expect(await response!.text()).toBe('net:https://panel.test/');
    expect(allCached()).toEqual(['https://panel.test/']);
  });

  it('любой адрес интерфейса при обрыве связи открывает сохранённую оболочку', async () => {
    await dispatch(req('/', { mode: 'navigate' }));
    network.mockRejectedValue(new TypeError('offline'));
    const response = await dispatch(req('/servers/1', { mode: 'navigate' }));
    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe('net:https://panel.test/');
  });

  it('без сети и без кеша показывает страницу «Нет связи» (503), а не ошибку браузера', async () => {
    network.mockRejectedValue(new TypeError('offline'));
    const response = await dispatch(req('/', { mode: 'navigate' }));
    expect(response!.status).toBe(503);
    expect(await response!.text()).toContain('Нет связи с панелью');
  });

  it('ошибочный ответ сервера (502 прокси) в кеш оболочки не попадает', async () => {
    network.mockResolvedValue(new Response('bad gateway', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    await dispatch(req('/', { mode: 'navigate' }));
    expect(allCached()).toEqual([]);
  });
});

describe('файлы сборки /assets: сначала кеш', () => {
  it('второй запрос идёт из кеша без сети', async () => {
    const first = await dispatch(req('/assets/index-abc.js'));
    expect(await first!.text()).toBe('net:https://panel.test/assets/index-abc.js');
    network.mockClear();
    const second = await dispatch(req('/assets/index-abc.js'));
    expect(await second!.text()).toBe('net:https://panel.test/assets/index-abc.js');
    expect(network).not.toHaveBeenCalled();
  });

  it('HTML вместо файла (запасной маршрут сервера для несуществующего пути) и ошибки не кешируются', async () => {
    await dispatch(req('/assets/missing.js')); // сеть вернёт text/javascript — кешируется
    network.mockResolvedValueOnce(new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await dispatch(req('/assets/gone.js'));
    network.mockResolvedValueOnce(new Response('nope', { status: 404, headers: { 'Content-Type': 'text/javascript' } }));
    await dispatch(req('/assets/err.js'));
    expect(allCached()).toEqual(['https://panel.test/assets/missing.js']);
  });

  it('кеш файлов ограничен: самые старые вытесняются', async () => {
    for (let i = 0; i < 125; i++) await dispatch(req(`/assets/f${i}.js`));
    const cache = caches.map.get('dementia-assets-v1')!;
    expect(cache.store.size).toBe(120);
    expect(cache.store.has('https://panel.test/assets/f0.js')).toBe(false);
    expect(cache.store.has('https://panel.test/assets/f124.js')).toBe(true);
  });
});

describe('иконки и манифест: из кеша с обновлением в фоне', () => {
  it('отдаёт сохранённый файл, а новую версию подтягивает', async () => {
    await dispatch(req('/manifest.webmanifest'));
    network.mockClear();
    network.mockResolvedValue(new Response('{"v":2}', { status: 200, headers: { 'Content-Type': 'application/manifest+json' } }));
    const response = await dispatch(req('/manifest.webmanifest'));
    expect(await response!.text()).toBe('net:https://panel.test/manifest.webmanifest');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(network).toHaveBeenCalledTimes(1);
  });
});

describe('установка и обновление воркера', () => {
  it('установка не падает, если часть файлов недоступна, и сразу активирует воркер', async () => {
    network.mockImplementation(async (request: string) => new Response('x', { status: request === '/icon-192.png' ? 404 : 200 }));
    let ready: Promise<unknown> = Promise.resolve();
    listeners.install({ waitUntil: (p: Promise<unknown>) => (ready = p) });
    await ready;
    expect(self.skipWaiting).toHaveBeenCalled();
    expect(await caches.map.get('dementia-shell-v1')!.match('/')).toBeDefined();
  });

  it('при активации удаляются кеши прежних версий, свои остаются', async () => {
    await caches.open('dementia-shell-v1');
    await caches.open('dementia-assets-v1');
    await caches.open('dementia-shell-v0');
    let ready: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (p: Promise<unknown>) => (ready = p) });
    await ready;
    expect((await caches.keys()).sort()).toEqual(['dementia-assets-v1', 'dementia-shell-v1']);
    expect(self.clients.claim).toHaveBeenCalled();
  });
});
