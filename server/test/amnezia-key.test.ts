import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { decodeAmneziaKey, encodeAmneziaKey, splitAmneziaKeys } from '../src/utils/amnezia-key.js';

const FULL_ACCESS = {
  hostName: '203.0.113.10',
  port: 2222,
  userName: 'root',
  password: 'secret-pass',
  description: 'Мой сервер в Германии',
  containers: [{ container: 'amnezia-awg2' }, { container: 'amnezia-xray' }],
  defaultContainer: 'amnezia-awg2',
  dns1: '1.1.1.1',
  dns2: '1.0.0.1',
};

describe('ключ полного доступа AmneziaVPN', () => {
  it('декодирует qCompress + base64url (как ExportController AmneziaVPN)', () => {
    const key = encodeAmneziaKey(FULL_ACCESS);
    expect(key.startsWith('vpn://')).toBe(true);
    expect(key.slice('vpn://'.length)).not.toMatch(/[+/=]/);
    expect(decodeAmneziaKey(key)).toEqual({
      host: '203.0.113.10',
      port: 2222,
      username: 'root',
      password: 'secret-pass',
      privateKey: null,
      description: 'Мой сервер в Германии',
      containers: ['amnezia-awg2', 'amnezia-xray'],
    });
  });

  it('распознаёт приватный SSH-ключ в поле password', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const access = decodeAmneziaKey(encodeAmneziaKey({ ...FULL_ACCESS, password: pem }));
    expect(access.password).toBeNull();
    expect(access.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('отклоняет ключ обычного подключения (без SSH-данных) с понятной подсказкой', () => {
    const key = encodeAmneziaKey({ containers: [{ container: 'amnezia-awg2' }], defaultContainer: 'amnezia-awg2' });
    expect(() => decodeAmneziaKey(key)).toThrow(/Полный доступ/);
  });

  it('принимает ключ без префикса vpn:// и несжатый JSON, отклоняет мусор', () => {
    const key = encodeAmneziaKey(FULL_ACCESS).slice('vpn://'.length);
    expect(decodeAmneziaKey(key).host).toBe('203.0.113.10');
    const plain = Buffer.from(JSON.stringify(FULL_ACCESS)).toString('base64url');
    expect(decodeAmneziaKey(`vpn://${plain}`).username).toBe('root');
    const rawZlib = 'vpn://' + zlib.deflateSync(Buffer.from(JSON.stringify(FULL_ACCESS))).toString('base64url');
    expect(decodeAmneziaKey(rawZlib).port).toBe(2222);
    expect(() => decodeAmneziaKey('vpn://not-a-key')).toThrow();
    expect(() => decodeAmneziaKey('')).toThrow();
  });

  it('разбивает ввод на ключи', () => {
    expect(splitAmneziaKeys('vpn://a\n\n  vpn://b vpn://c ')).toEqual(['vpn://a', 'vpn://b', 'vpn://c']);
  });
});
