import zlib from 'node:zlib';

/**
 * Ключ AmneziaVPN «Поделиться полным доступом» (vpn://…).
 *
 * Формат (amnezia-client, core/controllers/selfhosted/exportController.cpp):
 *   "vpn://" + base64url_без_паддинга( qCompress(JSON, 8) )
 * qCompress = 4 байта длины исходных данных (big-endian) + поток zlib.
 *
 * В JSON полного доступа (importController.cpp → importConfig):
 *   hostName, port, userName, password (пароль ИЛИ приватный SSH-ключ — поле secretData),
 *   description, containers[{ container: "amnezia-awg" | ... }], defaultContainer, dns1, dns2.
 * Ключ обычного подключения (без hostName/userName/password) управлять сервером не позволяет.
 */
export interface AmneziaAccess {
  host: string;
  port: number;
  username: string;
  password: string | null;
  privateKey: string | null;
  description: string | null;
  containers: string[];
}

export class AmneziaKeyError extends Error {}

/** Ключ — это настройки сервера, их размер измеряется килобайтами; больший распакованный размер — признак «бомбы» */
const MAX_KEY_JSON_BYTES = 1024 * 1024;

function decodePayload(raw: string): any {
  const data = raw.trim().replace(/^vpn:\/\//i, '').replace(/\s+/g, '');
  if (!data) throw new AmneziaKeyError('Пустой ключ');
  const bytes = Buffer.from(data, 'base64url');

  // Основной вариант — qCompress; на всякий случай поддерживаем и несжатый JSON
  const candidates: (() => string)[] = [
    () => zlib.inflateSync(bytes.subarray(4), { maxOutputLength: MAX_KEY_JSON_BYTES }).toString('utf-8'),
    () => zlib.inflateSync(bytes, { maxOutputLength: MAX_KEY_JSON_BYTES }).toString('utf-8'),
    () => (bytes.length <= MAX_KEY_JSON_BYTES ? bytes.toString('utf-8') : ''),
  ];
  for (const attempt of candidates) {
    try {
      const text = attempt();
      if (text.trim().startsWith('{')) return JSON.parse(text);
    } catch {
      // следующий вариант
    }
  }
  throw new AmneziaKeyError('Не удалось прочитать ключ: ожидается ключ AmneziaVPN вида vpn://…');
}

export function decodeAmneziaKey(raw: string): AmneziaAccess {
  const json = decodePayload(raw);
  const host = typeof json.hostName === 'string' ? json.hostName.trim() : '';
  const username = typeof json.userName === 'string' ? json.userName.trim() : '';
  const secret = typeof json.password === 'string' ? json.password : '';

  if (!host || !username || !secret) {
    throw new AmneziaKeyError(
      'Это ключ подключения, а не полного доступа. В AmneziaVPN откройте сервер → «Поделиться» → «Полный доступ».'
    );
  }

  const port = Number(json.port) || 22;
  const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  const containers = Array.isArray(json.containers)
    ? json.containers.map((c: any) => String(c?.container ?? '')).filter(Boolean)
    : [];

  return {
    host,
    port,
    username,
    password: isKey ? null : secret,
    privateKey: isKey ? secret.trim() + '\n' : null,
    description: typeof json.description === 'string' && json.description.trim() ? json.description.trim().slice(0, 64) : null,
    containers,
  };
}

/**
 * Разбивает ввод на отдельные ключи (по одному на строку или через пробел)
 */
export function splitAmneziaKeys(input: string): string[] {
  return String(input ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Обратная операция — для тестов: собирает ключ так же, как ExportController AmneziaVPN
 */
export function encodeAmneziaKey(json: unknown): string {
  const text = Buffer.from(JSON.stringify(json), 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(text.length);
  return 'vpn://' + Buffer.concat([header, zlib.deflateSync(text, { level: 8 })]).toString('base64url');
}
