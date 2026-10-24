import { describe, expect, it } from 'vitest';
import { allocateIp, formatEndpointHost, isValidHost, parseSubnet, shellQuote } from '../src/utils/net.js';
import { base64HeaderValue, contentDisposition } from '../src/utils/http.js';

describe('parseSubnet', () => {
  it('вычисляет адрес сети для NAT', () => {
    expect(parseSubnet('10.8.0.1/24').network).toBe('10.8.0.0/24');
    expect(parseSubnet('172.16.5.1/16').network).toBe('172.16.0.0/16');
    expect(parseSubnet('10.9.0.1/28').network).toBe('10.9.0.0/28');
  });

  it('отклоняет некорректные подсети и попытки инъекции', () => {
    expect(() => parseSubnet('10.8.0.1/24";id;"')).toThrow();
    expect(() => parseSubnet('10.8.0.0/24')).toThrow(); // адрес сети
    expect(() => parseSubnet('10.8.0.255/24')).toThrow(); // broadcast
    expect(() => parseSubnet('10.8.0.1/8')).toThrow();
    expect(() => parseSubnet('300.1.1.1/24')).toThrow();
  });
});

describe('allocateIp', () => {
  it('выдаёт первый свободный адрес, пропуская адрес сервера', () => {
    expect(allocateIp('10.8.0.1/24', [])).toBe('10.8.0.2');
    expect(allocateIp('10.8.0.1/24', ['10.8.0.2', '10.8.0.4'])).toBe('10.8.0.3');
    expect(allocateIp('10.8.0.5/24', [])).toBe('10.8.0.1');
  });

  it('учитывает маску: /16 даёт больше 253 адресов, /30 — только два хоста', () => {
    const used = Array.from({ length: 300 }, (_, i) => `10.0.${Math.floor((i + 2) / 256)}.${(i + 2) % 256}`);
    expect(allocateIp('10.0.0.1/16', used)).toBe('10.0.1.46');
    expect(allocateIp('10.0.0.1/30', [])).toBe('10.0.0.2');
    expect(() => allocateIp('10.0.0.1/30', ['10.0.0.2'])).toThrow(/переполнена/);
  });
});

describe('экранирование и заголовки', () => {
  it('shellQuote безопасно экранирует кавычки', () => {
    expect(shellQuote("a'b; rm -rf /")).toBe(`'a'\\''b; rm -rf /'`);
  });

  it('isValidHost пропускает IP и домены, отклоняет мусор', () => {
    expect(isValidHost('1.2.3.4')).toBe(true);
    expect(isValidHost('vpn.example.com')).toBe(true);
    expect(isValidHost('2001:db8::1')).toBe(true);
    expect(isValidHost('host; id')).toBe(false);
    expect(isValidHost('')).toBe(false);
  });

  it('IPv6 оборачивается в скобки для Endpoint', () => {
    expect(formatEndpointHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(formatEndpointHost('1.2.3.4')).toBe('1.2.3.4');
  });

  it('заголовки допускают кириллицу без ERR_INVALID_CHAR', () => {
    const disposition = contentDisposition('attachment', 'Иван "телефон".conf');
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(base64HeaderValue('Иван')).toBe('base64:0JjQstCw0L0=');
  });
});
