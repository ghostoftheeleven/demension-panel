import net from 'node:net';
import { db, getSetting, setSetting, transaction } from '../db/index.js';
import { HttpError } from '../utils/http.js';
import { PANEL_VERSION } from './version.service.js';

/**
 * Проверка доступности нод из выбранных стран. Сама панель стоит в одной стране, поэтому проверку выполняют узлы публичного
 * сервиса check-host.net (бесплатный API без ключа): ICMP-ping или TCP-подключение к ноде с их стороны. Это показывает
 * блокировку адреса ноды (IP-уровень); блокировку самого протокола WireGuard на UDP-порту так проверить нельзя.
 *
 * Функция отключена, пока администратор её не включит: адреса нод уходят на сторонний сервис.
 * Результаты — таблица probe_results, настройки — settings с префиксом probe_ (docs/probes.md).
 */

const API_BASE = 'https://check-host.net';
const NODE_ID = /^[a-z0-9-]+\.node\.check-host\.net$/;
const COUNTRY_CODE = /^[a-z]{2}$/;
const REQUEST_ID = /^[A-Za-z0-9]{3,40}$/;

export const MAX_PROBE_COUNTRIES = 8;
export const MIN_INTERVAL_MINUTES = 10;
export const MAX_INTERVAL_MINUTES = 1440;
const DEFAULT_INTERVAL_MINUTES = 30;
/** Сколько проверяющих узлов от страны привлекается к одной проверке */
const NODES_PER_COUNTRY = 2;
const COUNTRIES_TTL_MS = 24 * 60 * 60 * 1000;
/** Минимальный промежуток между ручными запусками */
const MANUAL_COOLDOWN_MS = 60 * 1000;
const POLL_TOTAL_MS = 45 * 1000;

export interface ProbeSettings {
  enabled: boolean;
  /** Коды стран ISO 3166-1 alpha-2 в нижнем регистре, в порядке показа */
  countries: string[];
  interval_minutes: number;
  /** Дописывать результаты к названию ноды в подписке */
  show_in_name: boolean;
  /** Дописывать пояснение к описанию подписки */
  show_in_description: boolean;
}

export interface ProbeCountry {
  code: string;
  /** Английское название из check-host.net (русское строит интерфейс) */
  name: string;
  nodes: string[];
  cities: string[];
}

export type ProbeStatus = 'ok' | 'partial' | 'fail';

export interface ProbeResult {
  server_id: number;
  country: string;
  ok_nodes: number;
  total_nodes: number;
  rtt_ms: number | null;
  checked_at: string;
  status: ProbeStatus;
}

interface CountryAggregate {
  ok: number;
  total: number;
  rtts: number[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function providerFetch(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': `dementia-panel/${PANEL_VERSION}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`check-host.net ответил HTTP ${res.status}`);
  return res.json();
}

/** Результат одного ping-узла: null — ответа нет (ещё считается или имя не разрешилось) */
export function parsePingResult(value: unknown): { ok: boolean; rtt: number | null } | null {
  if (!Array.isArray(value) || !Array.isArray(value[0])) return null;
  const attempts = value[0] as unknown[];
  if (attempts.length === 0 || (attempts.length === 1 && attempts[0] === null)) return null;
  const rtts: number[] = [];
  for (const attempt of attempts) {
    if (Array.isArray(attempt) && attempt[0] === 'OK' && typeof attempt[1] === 'number' && Number.isFinite(attempt[1])) rtts.push(attempt[1] * 1000);
  }
  return { ok: rtts.length > 0, rtt: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null };
}

/** Результат одного TCP-узла: объект с time — успех, с error — отказ */
export function parseTcpResult(value: unknown): { ok: boolean; rtt: number | null } | null {
  const entry = Array.isArray(value) ? value[0] : null;
  if (!entry || typeof entry !== 'object') return null;
  if (typeof (entry as any).time === 'number' && Number.isFinite((entry as any).time)) return { ok: true, rtt: Math.round((entry as any).time * 1000) };
  if ('error' in entry) return { ok: false, rtt: null };
  return null;
}

export function probeStatus(ok: number, total: number): ProbeStatus {
  if (total > 0 && ok === total) return 'ok';
  return ok === 0 ? 'fail' : 'partial';
}

/** Флаг страны из двух букв кода (региональные индикаторы Unicode) */
export function countryFlag(code: string): string {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const STATUS_MARK: Record<ProbeStatus, string> = { ok: '✅', partial: '⚠️', fail: '❌' };

function countryNameRu(code: string): string {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export class ProbeService {
  private static running = false;
  /** Пауза перед опросом результатов; тесты обнуляют её */
  static pollDelayMs: number | null = null;
  /** Сколько всего ждать ответы узлов; тесты уменьшают */
  static pollTotalMs = POLL_TOTAL_MS;
  private static countriesCache: { at: number; list: ProbeCountry[] } | null = null;

  // ---- Настройки ----

  static readSettings(): ProbeSettings {
    let countries: string[] = [];
    try {
      const parsed = JSON.parse(getSetting('probe_countries') || '[]');
      if (Array.isArray(parsed)) countries = parsed.filter((c) => typeof c === 'string' && COUNTRY_CODE.test(c)).slice(0, MAX_PROBE_COUNTRIES);
    } catch {
      countries = [];
    }
    const interval = Number(getSetting('probe_interval'));
    return {
      enabled: getSetting('probe_enabled') === '1',
      countries,
      interval_minutes: Number.isInteger(interval) && interval >= MIN_INTERVAL_MINUTES && interval <= MAX_INTERVAL_MINUTES ? interval : DEFAULT_INTERVAL_MINUTES,
      show_in_name: getSetting('probe_in_name') !== '0',
      show_in_description: getSetting('probe_in_description') !== '0',
    };
  }

  static updateSettings(body: Record<string, unknown>): ProbeSettings {
    const next = { ...this.readSettings() };

    if (body.countries !== undefined) {
      if (!Array.isArray(body.countries)) throw new HttpError(400, 'countries должен быть массивом кодов стран');
      const codes = [...new Set(body.countries.map((c) => String(c).trim().toLowerCase()))];
      if (codes.some((c) => !COUNTRY_CODE.test(c))) throw new HttpError(400, 'Страна задаётся двухбуквенным кодом (например, ru)');
      if (codes.length > MAX_PROBE_COUNTRIES) throw new HttpError(400, `Можно выбрать не более ${MAX_PROBE_COUNTRIES} стран`);
      next.countries = codes;
    }
    if (body.interval_minutes !== undefined) {
      const minutes = Number(body.interval_minutes);
      if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
        throw new HttpError(400, `Интервал проверки: от ${MIN_INTERVAL_MINUTES} до ${MAX_INTERVAL_MINUTES} минут`);
      }
      next.interval_minutes = minutes;
    }
    if (body.show_in_name !== undefined) next.show_in_name = Boolean(body.show_in_name);
    if (body.show_in_description !== undefined) next.show_in_description = Boolean(body.show_in_description);
    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
    if (next.enabled && next.countries.length === 0) throw new HttpError(400, 'Выберите хотя бы одну страну для проверки');

    const wasEnabled = this.readSettings().enabled;
    setSetting('probe_enabled', next.enabled ? '1' : null);
    setSetting('probe_countries', next.countries.length ? JSON.stringify(next.countries) : null);
    setSetting('probe_interval', next.interval_minutes === DEFAULT_INTERVAL_MINUTES ? null : String(next.interval_minutes));
    setSetting('probe_in_name', next.show_in_name ? null : '0');
    setSetting('probe_in_description', next.show_in_description ? null : '0');
    // Включение (или смена списка стран) — первая проверка при ближайшем обходе
    if (next.enabled && !wasEnabled) setSetting('probe_last_run', null);

    // Результаты стран, которые больше не проверяются, не должны попасть в подписку
    if (next.countries.length) {
      db.prepare(`DELETE FROM probe_results WHERE country NOT IN (${next.countries.map(() => '?').join(',')})`).run(...next.countries);
    } else {
      db.exec('DELETE FROM probe_results');
    }
    return next;
  }

  /** Порт TCP-проверки сервера: null — ICMP-ping */
  static setServerProbePort(serverId: number, port: unknown): void {
    let value: number | null = null;
    if (port !== null && port !== undefined && port !== '') {
      value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new HttpError(400, 'Порт TCP-проверки: число от 1 до 65535');
    }
    const result = db.prepare('UPDATE servers SET probe_port = ? WHERE id = ?').run(value, serverId);
    if (result.changes === 0) throw new HttpError(404, 'Сервер не найден');
    db.prepare('DELETE FROM probe_results WHERE server_id = ?').run(serverId);
  }

  static getStatus(): { running: boolean; last_run: string | null; error: string | null; next_run: string | null } {
    const lastRun = getSetting('probe_last_run');
    const settings = this.readSettings();
    return {
      running: this.running,
      last_run: lastRun,
      error: getSetting('probe_error'),
      next_run: settings.enabled && lastRun ? new Date(new Date(lastRun).getTime() + settings.interval_minutes * 60000).toISOString() : null,
    };
  }

  // ---- Список стран провайдера ----

  /** Страны, в которых у check-host.net есть проверяющие узлы (кэш на сутки) */
  static async listCountries(): Promise<ProbeCountry[]> {
    const cached = this.countriesCache;
    if (cached && Date.now() - cached.at < COUNTRIES_TTL_MS) return cached.list;

    try {
      const data = await providerFetch('/nodes/hosts');
      const byCode = new Map<string, ProbeCountry>();
      for (const [id, info] of Object.entries<any>(data?.nodes ?? {})) {
        const location = info?.location;
        if (!NODE_ID.test(id) || !Array.isArray(location) || typeof location[0] !== 'string' || !COUNTRY_CODE.test(location[0])) continue;
        const country = byCode.get(location[0]) ?? { code: location[0], name: String(location[1] ?? location[0]).slice(0, 60), nodes: [], cities: [] };
        country.nodes.push(id);
        const city = typeof location[2] === 'string' ? location[2].slice(0, 60) : '';
        if (city && !country.cities.includes(city)) country.cities.push(city);
        byCode.set(location[0], country);
      }
      const list = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
      if (list.length === 0) throw new Error('пустой список узлов');
      this.countriesCache = { at: Date.now(), list };
      return list;
    } catch (err: any) {
      if (cached) return cached.list;
      throw new HttpError(502, `Не удалось получить список стран у check-host.net: ${err.message}`);
    }
  }

  static resetCountriesCache(): void {
    this.countriesCache = null;
  }

  // ---- Проверка ----

  /**
   * Одна проверка адреса группой узлов: возвращает по каждой стране, сколько узлов дошло до ноды.
   * Узлы, не ответившие за отведённое время, в итог не входят.
   */
  static async checkHost(host: string, port: number | null, nodeIds: string[], countryOfNode: Map<string, string>): Promise<Map<string, CountryAggregate>> {
    const type = port ? 'tcp' : 'ping';
    const target = port ? `${net.isIPv6(host) ? `[${host}]` : host}:${port}` : host;
    const started = await providerFetch(`/check-${type}?host=${encodeURIComponent(target)}&${nodeIds.map((n) => `node=${encodeURIComponent(n)}`).join('&')}`);
    if (started?.ok !== 1 || !REQUEST_ID.test(String(started.request_id))) {
      throw new Error(typeof started?.error === 'string' ? started.error.slice(0, 120) : 'check-host.net отклонил запрос');
    }

    // Страна узла: из ответа на запуск, иначе из списка узлов
    const nodeCountry = new Map<string, string>();
    for (const id of nodeIds) {
      const info = started.nodes?.[id];
      const code = Array.isArray(info) && typeof info[0] === 'string' && COUNTRY_CODE.test(info[0]) ? info[0] : countryOfNode.get(id);
      if (code) nodeCountry.set(id, code);
    }

    const parse = type === 'ping' ? parsePingResult : parseTcpResult;
    const deadline = Date.now() + this.pollTotalMs;
    let results: Record<string, unknown> = {};
    for (;;) {
      await sleep(this.pollDelayMs ?? (type === 'ping' ? 4000 : 2500));
      results = (await providerFetch(`/check-result/${started.request_id}`)) ?? {};
      const pending = nodeIds.filter((id) => results[id] === null || results[id] === undefined);
      if (pending.length === 0 || Date.now() > deadline) break;
    }

    const aggregate = new Map<string, CountryAggregate>();
    for (const id of nodeIds) {
      const country = nodeCountry.get(id);
      const parsed = country ? parse(results[id]) : null;
      if (!country || !parsed) continue;
      const entry = aggregate.get(country) ?? { ok: 0, total: 0, rtts: [] };
      entry.total++;
      if (parsed.ok) {
        entry.ok++;
        if (parsed.rtt !== null) entry.rtts.push(parsed.rtt);
      }
      aggregate.set(country, entry);
    }
    return aggregate;
  }

  static isDue(): boolean {
    const settings = this.readSettings();
    if (!settings.enabled || settings.countries.length === 0 || this.running) return false;
    const lastRun = getSetting('probe_last_run');
    return !lastRun || Date.now() - new Date(lastRun).getTime() >= settings.interval_minutes * 60000;
  }

  /** Проверяет все установленные ноды из выбранных стран и сохраняет результаты */
  static async runAll(): Promise<{ checked: number; errors: string[] }> {
    const settings = this.readSettings();
    if (!settings.enabled || settings.countries.length === 0) throw new HttpError(400, 'Проверка из стран отключена');
    if (this.running) throw new HttpError(409, 'Проверка уже выполняется');

    this.running = true;
    const errors: string[] = [];
    let checked = 0;
    try {
      const countries = await this.listCountries();
      const byCode = new Map(countries.map((c) => [c.code, c]));
      const countryOfNode = new Map<string, string>();
      for (const c of countries) for (const id of c.nodes) countryOfNode.set(id, c.code);

      const nodeIds: string[] = [];
      const missing: string[] = [];
      for (const code of settings.countries) {
        const country = byCode.get(code);
        if (country) nodeIds.push(...country.nodes.slice(0, NODES_PER_COUNTRY));
        else missing.push(code.toUpperCase());
      }
      if (missing.length) errors.push(`нет проверяющих узлов в странах: ${missing.join(', ')}`);
      if (nodeIds.length === 0) throw new Error('для выбранных стран нет проверяющих узлов');

      const servers = db.prepare("SELECT id, name, host, probe_port FROM servers WHERE status != 'uninstalled' ORDER BY id").all() as {
        id: number;
        name: string;
        host: string;
        probe_port: number | null;
      }[];

      for (const server of servers) {
        try {
          const aggregate = await this.checkHost(server.host, server.probe_port, nodeIds, countryOfNode);
          const now = new Date().toISOString();
          transaction(() => {
            const upsert = db.prepare(`
              INSERT INTO probe_results (server_id, country, ok_nodes, total_nodes, rtt_ms, checked_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(server_id, country) DO UPDATE SET ok_nodes = excluded.ok_nodes, total_nodes = excluded.total_nodes,
                rtt_ms = excluded.rtt_ms, checked_at = excluded.checked_at
            `);
            for (const [country, a] of aggregate) {
              upsert.run(server.id, country, a.ok, a.total, a.rtts.length ? Math.round(a.rtts.reduce((x, y) => x + y, 0) / a.rtts.length) : null, now);
            }
          });
          checked++;
        } catch (err: any) {
          errors.push(`${server.name}: ${err.message}`);
        }
      }
    } catch (err: any) {
      errors.push(err.message);
    } finally {
      this.running = false;
      setSetting('probe_last_run', new Date().toISOString());
      setSetting('probe_error', errors.length ? errors.join('; ').slice(0, 500) : null);
    }
    return { checked, errors };
  }

  /** Ручной запуск: не чаще раза в минуту; выполняется в фоне */
  static startManualRun(): void {
    const settings = this.readSettings();
    if (!settings.enabled || settings.countries.length === 0) throw new HttpError(400, 'Сначала включите проверку и выберите страны');
    if (this.running) throw new HttpError(409, 'Проверка уже выполняется');
    const lastRun = getSetting('probe_last_run');
    if (lastRun && Date.now() - new Date(lastRun).getTime() < MANUAL_COOLDOWN_MS) {
      throw new HttpError(429, 'Проверку можно запускать не чаще раза в минуту');
    }
    this.runAll().catch((err) => console.error('[PROBE] Ошибка проверки:', err));
  }

  // ---- Результаты ----

  /** Результаты не старше трёх интервалов (но не менее двух часов): устаревшие в подписку не попадают */
  private static freshSince(): string {
    const minutes = Math.max(this.readSettings().interval_minutes * 3, 120);
    return new Date(Date.now() - minutes * 60000).toISOString();
  }

  static resultsFor(serverId: number): ProbeResult[] {
    const settings = this.readSettings();
    if (!settings.enabled) return [];
    const since = this.freshSince();
    const rows = db.prepare('SELECT * FROM probe_results WHERE server_id = ? AND checked_at >= ?').all(serverId, since) as any[];
    return rows
      .filter((r) => settings.countries.includes(r.country))
      .sort((a, b) => settings.countries.indexOf(a.country) - settings.countries.indexOf(b.country))
      .map((r) => ({ ...r, status: probeStatus(r.ok_nodes, r.total_nodes) }));
  }

  static allResults(): ProbeResult[] {
    const settings = this.readSettings();
    if (!settings.enabled) return [];
    const rows = db.prepare('SELECT * FROM probe_results WHERE checked_at >= ? ORDER BY server_id').all(this.freshSince()) as any[];
    return rows
      .filter((r) => settings.countries.includes(r.country))
      .sort((a, b) => a.server_id - b.server_id || settings.countries.indexOf(a.country) - settings.countries.indexOf(b.country))
      .map((r) => ({ ...r, status: probeStatus(r.ok_nodes, r.total_nodes) }));
  }

  // ---- Подписка ----

  /** Пометки для названий нод в подписке: serverId → «🇷🇺✅ 🇰🇿❌» */
  static getNameMarks(): Map<number, string> {
    const marks = new Map<number, string>();
    const settings = this.readSettings();
    if (!settings.enabled || !settings.show_in_name) return marks;
    const perServer = new Map<number, string[]>();
    for (const r of this.allResults()) {
      const list = perServer.get(r.server_id) ?? [];
      list.push(`${countryFlag(r.country)}${STATUS_MARK[r.status]}`);
      perServer.set(r.server_id, list);
    }
    for (const [id, list] of perServer) marks.set(id, list.join(' '));
    return marks;
  }

  /** Пояснение к описанию подписки; null, если проверка выключена или свежих результатов нет */
  static getLegend(): string | null {
    const settings = this.readSettings();
    if (!settings.enabled || !settings.show_in_description || settings.countries.length === 0) return null;
    const results = this.allResults();
    if (results.length === 0) return null;
    const shown = settings.countries.filter((c) => results.some((r) => r.country === c));
    const checkedAt = new Date(results.reduce((max, r) => (r.checked_at > max ? r.checked_at : max), ''));
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${pad(checkedAt.getUTCDate())}.${pad(checkedAt.getUTCMonth() + 1)} ${pad(checkedAt.getUTCHours())}:${pad(checkedAt.getUTCMinutes())} UTC`;
    return (
      `Доступность нод из стран: ${shown.map((c) => `${countryFlag(c)} ${countryNameRu(c)}`).join(', ')}. ` +
      `${STATUS_MARK.ok} доступна, ${STATUS_MARK.partial} не везде, ${STATUS_MARK.fail} недоступна. Проверено ${date}.`
    );
  }
}
