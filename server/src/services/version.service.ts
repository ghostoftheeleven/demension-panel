import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Репозиторий, в котором публикуются релизы панели */
export const RELEASES_REPO = 'ghostoftheeleven/demension-panel';
const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

/** Как долго помнится ответ GitHub (без токена API разрешает 60 запросов в час с одного адреса) */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** Повтор после ошибки (нет сети, лимит GitHub) */
const ERROR_TTL_MS = 30 * 60 * 1000;
/** Принудительная проверка из интерфейса — не чаще раза в минуту */
const FORCE_MIN_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

const VERSION_RE = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Версия панели — поле version корневого package.json (единственный источник номера версии).
 * Файл ищется рядом с исходниками (src/services и dist/services) и в рабочем каталоге службы.
 */
function readPanelVersion(): string {
  const candidates = [
    path.resolve(__dirname, '../../../package.json'),
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(process.cwd(), '../package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (pkg?.name === 'demension-panel' && typeof pkg.version === 'string' && VERSION_RE.test(pkg.version)) {
        return `v${pkg.version.replace(/^v/, '')}`;
      }
    } catch {
      // следующий кандидат
    }
  }
  return 'unknown';
}

export const PANEL_VERSION = readPanelVersion();

/** Номер версии в виде [мажор, минор, патч] или null, если строка не vX.Y.Z */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = VERSION_RE.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** >0 — a новее b, <0 — старее, 0 — одинаковые; некорректные версии считаются равными */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export interface LatestRelease {
  version: string;
  url: string;
  published_at: string | null;
}

/**
 * Разбор ответа GitHub API. Ответ — данные извне, поэтому берутся только поля строго известного формата:
 * тег vX.Y.Z, ссылка — только на страницу релиза этого репозитория.
 */
export function parseLatestRelease(body: any): LatestRelease | null {
  const parsed = parseVersion(body?.tag_name);
  if (!parsed) return null;
  const version = `v${parsed.join('.')}`;
  const url =
    typeof body.html_url === 'string' && body.html_url.startsWith(`${RELEASES_URL}/`) && /^[\w:/.%-]+$/.test(body.html_url)
      ? body.html_url
      : `${RELEASES_URL}/tag/${version}`;
  const published = typeof body.published_at === 'string' && !Number.isNaN(Date.parse(body.published_at))
    ? new Date(body.published_at).toISOString()
    : null;
  return { version, url, published_at: published };
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  latest_url: string | null;
  published_at: string | null;
  update_available: boolean;
  releases_url: string;
  checked_at: string | null;
  check_enabled: boolean;
  error: string | null;
}

interface CheckState {
  latest: LatestRelease | null;
  checkedAt: number;
  error: string | null;
}

let state: CheckState | null = null;
let inflight: Promise<void> | null = null;

/** Проверку обновлений можно отключить: DEMENSION_UPDATE_CHECK=0 (панель тогда не обращается к GitHub) */
function checkEnabled(): boolean {
  return process.env.DEMENSION_UPDATE_CHECK !== '0';
}

async function checkLatest(): Promise<void> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `demension-panel/${PANEL_VERSION}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      state = { latest: null, checkedAt: Date.now(), error: 'Релизы на GitHub ещё не опубликованы' };
      return;
    }
    if (!res.ok) throw new Error(`GitHub ответил HTTP ${res.status}`);
    const latest = parseLatestRelease(await res.json());
    if (!latest) throw new Error('GitHub вернул релиз без версии формата vX.Y.Z');
    state = { latest, checkedAt: Date.now(), error: null };
  } catch (err: any) {
    const message = err?.name === 'TimeoutError' ? 'GitHub не ответил вовремя' : err?.message || 'ошибка запроса';
    // Последняя известная версия не теряется из-за временной ошибки
    state = { latest: state?.latest ?? null, checkedAt: Date.now(), error: `Не удалось проверить обновления: ${message}` };
  }
}

function isStale(force: boolean): boolean {
  if (!state) return true;
  const age = Date.now() - state.checkedAt;
  if (force) return age >= FORCE_MIN_INTERVAL_MS;
  return age >= (state.error ? ERROR_TTL_MS : CHECK_TTL_MS);
}

export class VersionService {
  /**
   * Текущая версия панели и последняя версия из релизов GitHub (кэш 6 ч; повторные запросы объединяются)
   */
  static async getInfo(force = false): Promise<VersionInfo> {
    const enabled = checkEnabled();
    if (enabled && isStale(force)) {
      inflight ??= checkLatest().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    const latest = enabled ? state?.latest ?? null : null;
    return {
      current: PANEL_VERSION,
      latest: latest?.version ?? null,
      latest_url: latest?.url ?? null,
      published_at: latest?.published_at ?? null,
      update_available: Boolean(latest && compareVersions(latest.version, PANEL_VERSION) > 0),
      releases_url: RELEASES_URL,
      checked_at: enabled && state ? new Date(state.checkedAt).toISOString() : null,
      check_enabled: enabled,
      error: enabled ? state?.error ?? null : null,
    };
  }

  /** Для тестов: забыть результат проверки */
  static resetCache(): void {
    state = null;
    inflight = null;
  }
}
