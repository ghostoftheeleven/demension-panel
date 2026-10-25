import http from 'node:http';
import https from 'node:https';
import { deriveMigrationKeys, MigrationArchiveError } from '../utils/migration-archive.js';

/**
 * Перенос панели — сетевой клиент новой панели: забирает архив у прежней и сообщает ей о завершении.
 * Не импортирует БД (выполняется до запуска службы).
 *
 * Данные архива зашифрованы ключом из кода переноса, а запросы подписаны производной от кода, поэтому проверка TLS-сертификата
 * прежней панели не обязательна: самоподписанный сертификат (панель на IP) допускается после неудачной строгой проверки.
 */

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const TLS_CERT_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_NOT_YET_VALID',
]);

interface RawResponse {
  status: number;
  body: Buffer;
  insecureTls: boolean;
}

function rawRequest(url: URL, method: string, headers: Record<string, string>, body: string | null, insecure: boolean): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method,
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
        ...(url.protocol === 'https:' ? { rejectUnauthorized: !insecure } : {}),
        timeout: 60000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ARCHIVE_BYTES) return req.destroy(new Error('Ответ слишком велик'));
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), insecureTls: insecure }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Таймаут ответа панели')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function panelRequest(url: URL, method: string, headers: Record<string, string>, body: string | null = null): Promise<RawResponse> {
  try {
    return await rawRequest(url, method, headers, body, false);
  } catch (err: any) {
    if (url.protocol === 'https:' && TLS_CERT_ERRORS.has(err?.code)) return rawRequest(url, method, headers, body, true);
    throw err;
  }
}

/** Адрес прежней панели: схема обязательна, путь не учитывается */
export function parsePanelUrl(input: string): URL {
  const raw = String(input ?? '').trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new MigrationArchiveError('Некорректный адрес прежней панели. Пример: https://panel.example.com:3001 или http://203.0.113.5:3001');
  }
  if (!url.hostname) throw new MigrationArchiveError('Некорректный адрес прежней панели');
  return url;
}

function describeFailure(res: RawResponse): string {
  let message = '';
  try {
    const data = JSON.parse(res.body.toString('utf8'));
    if (data?.https) return 'Прежняя панель доступна только по HTTPS: укажите адрес с https:// (домен сертификата или IP)';
    if (typeof data?.error === 'string') message = data.error;
  } catch {
    // не JSON
  }
  if (res.status === 404) return 'Это не панель Demension нужной версии (метод переноса не найден): обновите прежнюю панель до v0.1.1 или новее';
  return message || `HTTP ${res.status}`;
}

/** Скачивает зашифрованный архив у прежней панели по коду переноса */
export async function downloadMigrationArchive(from: string, code: string): Promise<{ archive: Buffer; insecureTls: boolean }> {
  const { auth } = deriveMigrationKeys(code);
  const url = new URL('/api/migration/archive', parsePanelUrl(from).origin);
  let res: RawResponse;
  try {
    res = await panelRequest(url, 'GET', { 'X-Migration-Auth': auth });
  } catch (err: any) {
    throw new MigrationArchiveError(`Не удалось подключиться к прежней панели ${url.origin}: ${err.code || err.message}`);
  }
  if (res.status !== 200) throw new MigrationArchiveError(`Прежняя панель отказала в переносе: ${describeFailure(res)}`);
  return { archive: res.body, insecureTls: res.insecureTls };
}

/** Сообщает прежней панели, что новая запущена: та замораживается и перенаправляет ссылки подписок на newUrl */
export async function notifyMigrationFinished(from: string, code: string, newUrl: string): Promise<void> {
  const { auth } = deriveMigrationKeys(code);
  const url = new URL('/api/migration/finish', parsePanelUrl(from).origin);
  let res: RawResponse;
  try {
    res = await panelRequest(url, 'POST', { 'X-Migration-Auth': auth }, JSON.stringify({ newUrl }));
  } catch (err: any) {
    throw new MigrationArchiveError(`Не удалось связаться с прежней панелью: ${err.code || err.message}`);
  }
  if (res.status !== 200) throw new MigrationArchiveError(`Прежняя панель не подтвердила завершение: ${describeFailure(res)}`);
}
