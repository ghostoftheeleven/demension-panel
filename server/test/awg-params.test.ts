import { describe, expect, it } from 'vitest';
import {
  generateAwgParams,
  isValidSignature,
  parseHeaderRange,
  parseServerConfig,
  renderAwgLines,
  validateAwgParams,
} from '../src/utils/awg-params.js';
import { parseScanOutput } from '../src/services/provision.service.js';
import { mihomoAmneziaOption } from '../src/routes/subscription.js';
import { paramsToColumns } from '../src/utils/awg-params.js';

const AMNEZIA_CONF = `[Interface]
PrivateKey = cK8nE1mF7bB3Y2h3a1Yj0b0mXn3w7Qm4zP6V0f9Q2kM=
Address = 10.8.1.0/24
ListenPort = 41582
Jc = 5
Jmin = 10
Jmax = 50
S1 = 64
S2 = 77
S3 = 20
S4 = 16
H1 = 1111111-1222222
H2 = 2111111-2222222
H3 = 3111111-3222222
H4 = 4111111-4222222
HeaderProtectionKey = 8Bq1nC9yMB3W0wLqk2Eo3lXzZ1y0X0mY7rQeQv6Nn0o=
RandomTrailers = on

[Peer]
PublicKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
PresharedKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
AllowedIPs = 10.8.1.1/32

[Peer]
PublicKey = CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=
PresharedKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
AllowedIPs = 10.8.1.2/32
`;

describe('параметры AmneziaWG 3.x', () => {
  it('генератор актуальной версии всегда выдаёт корректные параметры', () => {
    for (let i = 0; i < 2000; i++) {
      const p = generateAwgParams();
      expect(p.awg_version).toBe(3);
      expect(validateAwgParams(p)).toBeNull();
      expect(p.header_protection_key).toBeTruthy();
      for (const s of [p.s1, p.s2, p.s3!, p.s4!]) expect(s).toBeGreaterThanOrEqual(12);
      expect(p.s4!).toBeLessThanOrEqual(32);
    }
  });

  it('генератор версии 1 выдаёт одиночные H без S3/S4', () => {
    const p = generateAwgParams(1);
    expect(validateAwgParams(p)).toBeNull();
    expect(p.s3).toBeNull();
    expect(p.h1).toMatch(/^\d+$/);
  });

  it('проверка ловит пересечение диапазонов, малые паддинги с ключом и диапазоны в версии 1', () => {
    const p = generateAwgParams();
    expect(validateAwgParams({ ...p, h1: '100-200', h2: '150-300' })).toMatch(/пересекаться/);
    expect(validateAwgParams({ ...p, s3: 5 })).toMatch(/не меньше 12/);
    expect(validateAwgParams({ ...p, s3: 5, header_protection_key: null })).toBeNull();
    expect(validateAwgParams({ ...p, s4: 40 })).toMatch(/S4/);
    expect(validateAwgParams({ ...generateAwgParams(1), h1: '100-200' })).toMatch(/1\.x/);
    expect(validateAwgParams({ ...p, header_protection_key: 'short' })).toMatch(/HeaderProtectionKey/);
  });

  it('диапазоны и теги сигнатур', () => {
    expect(parseHeaderRange('123-456')).toEqual({ min: 123, max: 456 });
    expect(parseHeaderRange('77')).toEqual({ min: 77, max: 77 });
    expect(parseHeaderRange('456-123')).toBeNull();
    expect(isValidSignature('<b 0xc0ff> <r 16><t><rc 8>')).toBe(true);
    expect(isValidSignature('<c>')).toBe(false);
    expect(isValidSignature('<b 0xabc>')).toBe(false);
  });

  it('I1–I5 попадают только в клиентский конфиг', () => {
    const p = { ...generateAwgParams(), i1: '<r 32>' };
    expect(renderAwgLines(p, 'client')).toContain('I1 = <r 32>');
    expect(renderAwgLines(p, 'server')).not.toContain('I1');
    expect(renderAwgLines(p, 'server')).toContain('HeaderProtectionKey');
  });
});

describe('импорт существующей установки', () => {
  it('разбирает конфиг приложения Amnezia (AWG 3.x)', () => {
    const parsed = parseServerConfig(AMNEZIA_CONF);
    expect(parsed.listenPort).toBe(41582);
    expect(parsed.address).toBe('10.8.1.0/24');
    expect(parsed.params.awg_version).toBe(3);
    expect(parsed.params.h1).toBe('1111111-1222222');
    expect(parsed.params.extra_params).toEqual({ RandomTrailers: 'on' });
    expect(parsed.peers).toHaveLength(2);
    expect(parsed.peers[1]).toMatchObject({ ip: '10.8.1.2', presharedKey: expect.any(String) });
    expect(validateAwgParams(parsed.params)).toBeNull();
  });

  it('устаревший конфиг без S3/S4 распознаётся как версия 1', () => {
    const legacy = AMNEZIA_CONF.replace(/S3 = .*\n|S4 = .*\n|HeaderProtectionKey = .*\n|RandomTrailers = .*\n/g, '')
      .replace(/H(\d) = (\d+)-\d+/g, 'H$1 = $2');
    expect(parseServerConfig(legacy).params.awg_version).toBe(1);
  });

  it('разбирает вывод сканирования ноды', () => {
    const output = [
      '---CONTAINER amnezia-dns|amnezia-dns|true',
      '---CONTAINER amnezia-awg2|amnezia-awg2|true',
      '---CONF /opt/amnezia/awg/awg0.conf',
      AMNEZIA_CONF,
      '---ENDCONF',
      '---TOOL awg',
      '---CLIENTS',
      JSON.stringify([{ clientId: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=', userData: { clientName: 'Телефон Ивана' } }]),
      '---ENDCLIENTS',
      '---CONTAINER amnezia-awg|amnezia-awg|false',
    ].join('\n');
    const found = parseScanOutput(output);
    expect(found.map((c) => c.name)).toEqual(['amnezia-dns', 'amnezia-awg2', 'amnezia-awg']);
    const awg = found[1];
    expect(awg.confPath).toBe('/opt/amnezia/awg/awg0.conf');
    expect(awg.managedBy).toBe('amnezia');
    expect(awg.config).toContain('ListenPort = 41582');
    expect(awg.clientNames['CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=']).toBe('Телефон Ивана');
    expect(found[2].running).toBe(false);
  });
});

describe('mihomo', () => {
  it('для AWG 3.x передаёт version 3, S3/S4 и защиту заголовков', () => {
    const p = { ...generateAwgParams(), i1: '<r 16>', extra_params: { RandomTrailers: 'on', ContentPaddingAddition: '8-16' } };
    const option = mihomoAmneziaOption(paramsToColumns(p));
    expect(option).toMatchObject({
      version: 3,
      s3: p.s3,
      s4: p.s4,
      h1: p.h1,
      i1: '<r 16>',
      'header-protection-key': p.header_protection_key,
      'random-trailers': true,
      'content-padding-addition': '8-16',
    });
  });
});
