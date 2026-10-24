import net from 'node:net';
import { HttpError } from './http.js';

export interface ParsedSubnet {
  /** Адрес сервера внутри туннеля, например 10.8.0.1 */
  serverIp: string;
  prefix: number;
  /** Адрес сети в CIDR-нотации, например 10.8.0.0/24 (используется для NAT) */
  network: string;
  networkInt: number;
  broadcastInt: number;
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

/**
 * Разбирает подсеть вида "10.8.0.1/24", где адрес — IP сервера в туннеле.
 * Допустимы маски /16../30, адрес сервера должен быть хостовым адресом подсети.
 */
export function parseSubnet(subnet: string, strict = true): ParsedSubnet {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(subnet).trim());
  if (!match || net.isIPv4(match[1]) === false) {
    throw new Error('Подсеть должна быть в формате 10.8.0.1/24');
  }
  const prefix = Number(match[2]);
  if (prefix < 16 || prefix > 30) {
    throw new Error('Маска подсети должна быть от /16 до /30');
  }
  const serverInt = ipToInt(match[1]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (serverInt & mask) >>> 0;
  const broadcastInt = (networkInt | (~mask >>> 0)) >>> 0;
  // Приложение Amnezia указывает адрес сети (10.8.1.0/24) — такие подсети принимаются при импорте (strict = false)
  if (strict && (serverInt === networkInt || serverInt === broadcastInt)) {
    throw new Error('Адрес сервера не может быть адресом сети или широковещательным адресом');
  }
  return {
    serverIp: match[1],
    prefix,
    network: `${intToIp(networkInt)}/${prefix}`,
    networkInt,
    broadcastInt,
  };
}

/**
 * Возвращает первый свободный хостовый адрес подсети (без адреса сервера).
 */
export function allocateIp(subnet: string, usedIps: Iterable<string>): string {
  const parsed = parseSubnet(subnet, false);
  const used = new Set<number>();
  for (const ip of usedIps) {
    if (net.isIPv4(ip)) used.add(ipToInt(ip));
  }
  used.add(ipToInt(parsed.serverIp));

  for (let candidate = parsed.networkInt + 1; candidate < parsed.broadcastInt; candidate++) {
    if (!used.has(candidate)) return intToIp(candidate);
  }
  throw new HttpError(409, 'Подсеть сервера переполнена: нет свободных IP-адресов');
}

export function isValidPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

/**
 * Хост ноды: IPv4/IPv6 или доменное имя.
 */
export function isValidHost(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  if (net.isIP(host)) return true;
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(host);
}

/**
 * Безопасное экранирование значения для подстановки в POSIX shell.
 */
export function shellQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Хост для подстановки в URI/Endpoint: IPv6 нужно оборачивать в квадратные скобки.
 */
export function formatEndpointHost(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

/**
 * Адрес для перенаправления HTTP → HTTPS. Хост берётся из настроенного сертификата, а не из заголовка Host:
 * иначе запрос с произвольным Host получил бы редирект на сторонний сайт. Порт берётся из Host
 * (HTTP и HTTPS обслуживаются на одном порту). Если безопасного хоста нет, возвращается null.
 */
export function httpsRedirectLocation(hostHeader: string | undefined, originalUrl: string, certDomain: string | null): string | null {
  const domain = (certDomain || '').trim().toLowerCase();
  if (!domain) return null;

  const header = String(hostHeader || '').trim().toLowerCase();
  const portMatch = /:(\d{1,5})$/.exec(header);
  const port = portMatch && Number(portMatch[1]) >= 1 && Number(portMatch[1]) <= 65535 ? `:${Number(portMatch[1])}` : '';
  const requested = (portMatch ? header.slice(0, portMatch.index) : header).replace(/^\[|\]$/g, '');

  let host = domain;
  if (domain.startsWith('*.')) {
    // Сертификат на поддомены: подходит только имя, которое он действительно покрывает
    if (!requested.endsWith(domain.slice(1)) || !isValidHost(requested)) return null;
    host = requested;
  } else if (!isValidHost(domain)) {
    return null;
  }

  const path = originalUrl.startsWith('/') ? originalUrl : '/';
  return `https://${formatEndpointHost(host)}${port}${path}`;
}
