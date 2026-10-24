import crypto from 'node:crypto';

/**
 * Параметры обфускации AmneziaWG.
 *
 * Спецификация — README amneziawg-go и парсер amneziawg-tools (src/config.c):
 * - Jc, Jmin, Jmax, I1–I5 — «client-side»: могут отличаться на клиенте и сервере;
 * - S1–S4, H1–H4, HeaderProtectionKey — «server-side»: должны совпадать;
 * - H1–H4 с версии 2.0 — диапазоны `a-b`, которые не должны пересекаться;
 * - HeaderProtectionKey (3.x) требует S1–S4 не меньше 12.
 *
 * version 1 — устаревший формат (AWG 1.x: одиночные H, без S3/S4), version 3 — актуальный (AWG 3.x).
 */
export type AwgVersion = 1 | 3;

export interface AwgParams {
  awg_version: AwgVersion;
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  s3: number | null;
  s4: number | null;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  i1: string | null;
  i2: string | null;
  i3: string | null;
  i4: string | null;
  i5: string | null;
  header_protection_key: string | null;
  /** Прочие параметры [Interface] (например, из импортированного конфига Amnezia), сохраняются как есть */
  extra_params: Record<string, string>;
}

export const LATEST_AWG_VERSION: AwgVersion = 3;
export const AWG_PARAM_KEYS = [
  'awg_version', 'jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4',
  'i1', 'i2', 'i3', 'i4', 'i5', 'header_protection_key',
] as const;

/** Дополнительные параметры AWG 3.x, которые панель сохраняет и передаёт клиентам */
export const EXTRA_PARAM_KEYS = [
  'ContentPaddingAddition',
  'RekeyAfterTime',
  'RekeyTimeout',
  'RejectAfterTime',
  'KeepaliveTimeout',
  'MaxHandshakeAttempts',
  'RandomTrailers',
  'DisableCookies',
] as const;

const UINT32_MAX = 0xffffffff;
const HEADER_PROTECTION_MIN_PADDING = 12;
const S4_MAX = 32;

const randomInt = (min: number, max: number) => crypto.randomInt(min, max + 1);

export interface HeaderRange {
  min: number;
  max: number;
}

export function parseHeaderRange(value: string | number): HeaderRange | null {
  const match = /^\s*(\d{1,10})\s*(?:-\s*(\d{1,10}))?\s*$/.exec(String(value));
  if (!match) return null;
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (min > max || max > UINT32_MAX) return null;
  return { min, max };
}

/**
 * Четыре непересекающихся диапазона заголовков: пространство [5, 2^32) делится на четыре части,
 * в каждой выбирается случайный диапазон, затем части перемешиваются.
 */
function generateHeaderRanges(): string[] {
  const start = 5;
  const segment = Math.floor((UINT32_MAX - start) / 4);
  const ranges: string[] = [];
  for (let i = 0; i < 4; i++) {
    const segStart = start + i * segment;
    const width = randomInt(10_000, 5_000_000);
    const min = randomInt(segStart, segStart + segment - width - 1);
    ranges.push(`${min}-${min + width}`);
  }
  for (let i = ranges.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [ranges[i], ranges[j]] = [ranges[j], ranges[i]];
  }
  return ranges;
}

export function generateHeaderProtectionKey(): string {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Случайные параметры для заданной версии протокола (по умолчанию — актуальной)
 */
export function generateAwgParams(version: AwgVersion = LATEST_AWG_VERSION): AwgParams {
  const jmin = randomInt(40, 80);
  const jmax = randomInt(jmin + 20, jmin + 150);

  if (version === 1) {
    const s1 = randomInt(15, 120);
    let s2 = randomInt(15, 120);
    while (s1 + 56 === s2) s2 = randomInt(15, 120);
    const headers = new Set<number>();
    while (headers.size < 4) headers.add(randomInt(100000000, 2147483647));
    const [h1, h2, h3, h4] = [...headers].map(String);
    return {
      awg_version: 1, jc: randomInt(3, 10), jmin, jmax, s1, s2, s3: null, s4: null, h1, h2, h3, h4,
      i1: null, i2: null, i3: null, i4: null, i5: null, header_protection_key: null, extra_params: {},
    };
  }

  // AWG 3.x: все паддинги не меньше 12 — иначе нельзя включить защиту заголовков
  const s1 = randomInt(15, 150);
  let s2 = randomInt(15, 150);
  while (s1 + 56 === s2) s2 = randomInt(15, 150);
  const [h1, h2, h3, h4] = generateHeaderRanges();
  return {
    awg_version: 3,
    jc: randomInt(4, 10),
    jmin,
    jmax,
    s1,
    s2,
    s3: randomInt(HEADER_PROTECTION_MIN_PADDING, 55),
    s4: randomInt(HEADER_PROTECTION_MIN_PADDING, S4_MAX),
    h1, h2, h3, h4,
    i1: null, i2: null, i3: null, i4: null, i5: null,
    header_protection_key: generateHeaderProtectionKey(),
    extra_params: {},
  };
}

/**
 * Проверка цепочки тегов I1–I5 (amneziawg-go не поддерживает тег <c>)
 */
export function isValidSignature(value: string): boolean {
  const tag = /<b 0x(?:[0-9a-fA-F]{2})+>|<r \d{1,4}>|<rd \d{1,4}>|<rc \d{1,4}>|<t>/y;
  const text = value.trim();
  if (!text) return false;
  let pos = 0;
  while (pos < text.length) {
    if (/\s/.test(text[pos])) {
      pos++;
      continue;
    }
    tag.lastIndex = pos;
    const match = tag.exec(text);
    if (!match) return false;
    pos += match[0].length;
  }
  return true;
}

function isBase64Key(value: string): boolean {
  return /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32;
}

/**
 * Проверка параметров; возвращает текст ошибки или null
 */
export function validateAwgParams(p: AwgParams): string | null {
  for (const key of ['jc', 'jmin', 'jmax', 's1', 's2'] as const) {
    if (!Number.isInteger(p[key]) || p[key] < 0) return `Параметр ${key.toUpperCase()} должен быть целым неотрицательным числом`;
  }
  if (p.jc > 128) return 'Jc не может превышать 128';
  if (p.jmin > p.jmax) return 'Jmin не может быть больше Jmax';
  if (p.jmax > 1280) return 'Jmax не может превышать 1280';
  if (p.s1 > 1132) return 'S1 не может превышать 1132';
  if (p.s2 > 1188) return 'S2 не может превышать 1188';
  if (p.s1 + 56 === p.s2) return 'S1 + 56 не должно быть равно S2 (пакеты станут неразличимы)';

  const ranges: HeaderRange[] = [];
  for (const key of ['h1', 'h2', 'h3', 'h4'] as const) {
    const range = parseHeaderRange(p[key]);
    if (!range) return `${key.toUpperCase()}: укажите число или диапазон вида 100000-200000 (до ${UINT32_MAX})`;
    if (p.awg_version === 1 && range.min !== range.max) return `${key.toUpperCase()}: в AmneziaWG 1.x допускается только одно число`;
    if (range.min < 5) return `${key.toUpperCase()}: значения 0–4 зарезервированы WireGuard`;
    ranges.push(range);
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (ranges[i].min <= ranges[j].max && ranges[j].min <= ranges[i].max) {
        return `H${i + 1} и H${j + 1} не должны пересекаться`;
      }
    }
  }

  if (p.awg_version === 1) {
    if (p.s3 !== null || p.s4 !== null || p.header_protection_key) return 'S3, S4 и HeaderProtectionKey доступны только в AmneziaWG 3.x';
  } else {
    for (const key of ['s3', 's4'] as const) {
      const value = p[key];
      if (value === null || !Number.isInteger(value) || value < 0 || value > 65535) {
        return `Параметр ${key.toUpperCase()} должен быть целым неотрицательным числом`;
      }
    }
    if ((p.s4 as number) > S4_MAX) return `S4 не может превышать ${S4_MAX}`;
    if (p.header_protection_key) {
      if (!isBase64Key(p.header_protection_key)) return 'HeaderProtectionKey должен быть ключом в base64 (как у awg genkey)';
      const paddings = [p.s1, p.s2, p.s3 as number, p.s4 as number];
      if (paddings.some((s) => s < HEADER_PROTECTION_MIN_PADDING)) {
        return `С HeaderProtectionKey все S1–S4 должны быть не меньше ${HEADER_PROTECTION_MIN_PADDING}`;
      }
    }
  }

  for (const key of ['i1', 'i2', 'i3', 'i4', 'i5'] as const) {
    const value = p[key];
    if (value && !isValidSignature(value)) {
      return `${key.toUpperCase()}: допустимы теги <b 0x..>, <r N>, <rd N>, <rc N>, <t>`;
    }
  }

  for (const [key, value] of Object.entries(p.extra_params || {})) {
    if (!(EXTRA_PARAM_KEYS as readonly string[]).includes(key)) return `Неизвестный параметр ${key}`;
    if (!/^[\w.,:-]{1,64}$/.test(value)) return `Некорректное значение параметра ${key}`;
  }
  return null;
}

/**
 * Строки секции [Interface] с параметрами обфускации.
 * I1–I5 нужны только клиенту (рекомендация amneziawg-go), остальное — обеим сторонам.
 */
export function renderAwgLines(p: AwgParams, side: 'server' | 'client'): string {
  const lines: string[] = [
    `Jc = ${p.jc}`,
    `Jmin = ${p.jmin}`,
    `Jmax = ${p.jmax}`,
    `S1 = ${p.s1}`,
    `S2 = ${p.s2}`,
  ];
  if (p.s3 !== null && p.s3 !== undefined) lines.push(`S3 = ${p.s3}`);
  if (p.s4 !== null && p.s4 !== undefined) lines.push(`S4 = ${p.s4}`);
  lines.push(`H1 = ${p.h1}`, `H2 = ${p.h2}`, `H3 = ${p.h3}`, `H4 = ${p.h4}`);
  if (side === 'client') {
    for (const key of ['i1', 'i2', 'i3', 'i4', 'i5'] as const) {
      if (p[key]) lines.push(`${key.toUpperCase()} = ${p[key]}`);
    }
  }
  if (p.header_protection_key) lines.push(`HeaderProtectionKey = ${p.header_protection_key}`);
  for (const [key, value] of Object.entries(p.extra_params || {})) lines.push(`${key} = ${value}`);
  return lines.join('\n');
}

/**
 * Параметры из строки таблицы servers
 */
export function paramsFromRow(row: any): AwgParams {
  let extra: Record<string, string> = {};
  try {
    extra = row.extra_params ? JSON.parse(row.extra_params) : {};
  } catch {
    extra = {};
  }
  const nullableInt = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  const nullableText = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    awg_version: Number(row.awg_version) === 3 ? 3 : 1,
    jc: Number(row.jc),
    jmin: Number(row.jmin),
    jmax: Number(row.jmax),
    s1: Number(row.s1),
    s2: Number(row.s2),
    s3: nullableInt(row.s3),
    s4: nullableInt(row.s4),
    h1: String(row.h1),
    h2: String(row.h2),
    h3: String(row.h3),
    h4: String(row.h4),
    i1: nullableText(row.i1),
    i2: nullableText(row.i2),
    i3: nullableText(row.i3),
    i4: nullableText(row.i4),
    i5: nullableText(row.i5),
    header_protection_key: nullableText(row.header_protection_key),
    extra_params: extra,
  };
}

/**
 * Значения для записи в таблицу servers
 */
export function paramsToColumns(p: AwgParams): Record<string, string | number | null> {
  return {
    awg_version: p.awg_version,
    jc: p.jc,
    jmin: p.jmin,
    jmax: p.jmax,
    s1: p.s1,
    s2: p.s2,
    s3: p.s3,
    s4: p.s4,
    h1: p.h1,
    h2: p.h2,
    h3: p.h3,
    h4: p.h4,
    i1: p.i1,
    i2: p.i2,
    i3: p.i3,
    i4: p.i4,
    i5: p.i5,
    header_protection_key: p.header_protection_key,
    extra_params: Object.keys(p.extra_params || {}).length ? JSON.stringify(p.extra_params) : null,
  };
}

// ==============================================================================
// Разбор существующего awg0.conf / wg0.conf (импорт уже установленного AmneziaWG)
// ==============================================================================

export interface ParsedPeer {
  publicKey: string;
  presharedKey: string | null;
  ip: string | null;
}

export interface ParsedServerConfig {
  privateKey: string;
  address: string;
  listenPort: number;
  params: AwgParams;
  peers: ParsedPeer[];
}

export function parseServerConfig(text: string): ParsedServerConfig {
  const iface: Record<string, string> = {};
  const peers: ParsedPeer[] = [];
  let section = '';
  let current: Record<string, string> | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      if (section === 'peer') {
        current = {};
        peers.push(current as unknown as ParsedPeer);
      }
      continue;
    }
    const kv = /^([A-Za-z0-9]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (section === 'interface') iface[kv[1].toLowerCase()] = kv[2].trim();
    else if (section === 'peer' && current) current[kv[1].toLowerCase()] = kv[2].trim();
  }

  if (!iface.privatekey || !iface.listenport || !iface.address) {
    throw new Error('В конфигурации нет PrivateKey, ListenPort или Address');
  }

  const has = (k: string) => iface[k] !== undefined && iface[k] !== '';
  const hasV2 = has('s3') || has('s4') || has('headerprotectionkey') || ['h1', 'h2', 'h3', 'h4'].some((k) => iface[k]?.includes('-'));
  const extra: Record<string, string> = {};
  for (const key of EXTRA_PARAM_KEYS) {
    const value = iface[key.toLowerCase()];
    if (value !== undefined && value !== '') extra[key] = value;
  }

  const params: AwgParams = {
    awg_version: hasV2 ? 3 : 1,
    jc: Number(iface.jc ?? 0),
    jmin: Number(iface.jmin ?? 0),
    jmax: Number(iface.jmax ?? 0),
    s1: Number(iface.s1 ?? 0),
    s2: Number(iface.s2 ?? 0),
    s3: has('s3') ? Number(iface.s3) : hasV2 ? 0 : null,
    s4: has('s4') ? Number(iface.s4) : hasV2 ? 0 : null,
    h1: iface.h1 ?? '1',
    h2: iface.h2 ?? '2',
    h3: iface.h3 ?? '3',
    h4: iface.h4 ?? '4',
    i1: iface.i1 || null,
    i2: iface.i2 || null,
    i3: iface.i3 || null,
    i4: iface.i4 || null,
    i5: iface.i5 || null,
    header_protection_key: iface.headerprotectionkey || null,
    extra_params: extra,
  };

  return {
    privateKey: iface.privatekey,
    address: iface.address.split(',')[0].trim(),
    listenPort: Number(iface.listenport),
    params,
    peers: peers
      .map((p: any) => ({
        publicKey: p.publickey,
        presharedKey: p.presharedkey || null,
        ip: (p.allowedips || '').split(',').map((s: string) => s.trim()).find((s: string) => /^\d+\.\d+\.\d+\.\d+\/32$/.test(s))?.split('/')[0] ?? null,
      }))
      .filter((p) => p.publicKey),
  };
}
