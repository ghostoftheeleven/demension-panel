import { beforeAll, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AwgService } from '../src/services/awg.service.js';
import { ProvisionService } from '../src/services/provision.service.js';
import { decryptSecret, encryptSecret } from '../src/services/secrets.service.js';

beforeAll(() => {
  initDatabase();
});

describe('AwgService', () => {
  it('генератор всегда выдаёт параметры, удовлетворяющие ограничениям AmneziaWG', () => {
    for (let i = 0; i < 2000; i++) {
      const params = AwgService.generateRandomParams();
      expect(AwgService.validateParams(params)).toBeNull();
    }
  });

  it('validateParams ловит S1 + 56 = S2, Jmin ≥ Jmax и одинаковые H', () => {
    const base = AwgService.generateRandomParams();
    expect(AwgService.validateParams({ ...base, s1: 20, s2: 76 })).toMatch(/S1 \+ 56/);
    expect(AwgService.validateParams({ ...base, jmin: 80, jmax: 50 })).toMatch(/Jmin/);
    expect(AwgService.validateParams({ ...base, h2: base.h1 })).toMatch(/различными/);
  });

  it('derivePublicKey совпадает с ключом из generateKeyPair', () => {
    const pair = AwgService.generateKeyPair();
    expect(AwgService.derivePublicKey(pair.privateKey)).toBe(pair.publicKey);
  });

  it('конфиг сервера не включает выключенных клиентов и приостановленных подписчиков', () => {
    const server = { server_private_key: 'k', subnet: '10.8.0.1/24', awg_port: 1, preshared_key: 'p', ...AwgService.generateRandomParams() };
    const conf = AwgService.generateServerConfig(server, [
      { enabled: 1, subscriber_active: 1, client_public_key: 'ACTIVE', client_ip: '10.8.0.2' },
      { enabled: 0, subscriber_active: 1, client_public_key: 'DISABLED', client_ip: '10.8.0.3' },
      { enabled: 1, subscriber_active: 0, client_public_key: 'SUSPENDED', client_ip: '10.8.0.4' },
    ]);
    expect(conf).toContain('ACTIVE');
    expect(conf).not.toContain('DISABLED');
    expect(conf).not.toContain('SUSPENDED');
  });
});

describe('секреты', () => {
  it('шифрование обратимо и не хранит исходный текст', () => {
    const encrypted = encryptSecret('root-password')!;
    expect(encrypted).not.toContain('root-password');
    expect(decryptSecret(encrypted)).toBe('root-password');
    expect(decryptSecret('plain-legacy')).toBe('plain-legacy');
  });
});

describe('накопление трафика', () => {
  it('прибавляет прирост и переживает сброс счётчиков интерфейса', () => {
    const server = db.prepare("INSERT INTO servers (name, host, status) VALUES ('t', '1.1.1.1', 'online')").run();
    const serverId = Number(server.lastInsertRowid);
    db.prepare(
      "INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key) VALUES (?, 'c', '10.8.0.2', 'PUB', 'PRIV')"
    ).run(serverId);

    const dump = (rx: number, tx: number) => `priv\tpub\t51820\toff\nPUB\tpsk\t1.2.3.4:5\t10.8.0.2/32\t1700000000\t${rx}\t${tx}\t25\n`;
    const totals = () => db.prepare('SELECT total_rx, total_tx FROM clients WHERE server_id = ?').get(serverId) as any;

    ProvisionService.applyDump(serverId, dump(100, 1000));
    ProvisionService.applyDump(serverId, dump(150, 1500));
    expect(totals()).toEqual({ total_rx: 150, total_tx: 1500 });

    // Перезапуск контейнера: счётчики начались с нуля
    ProvisionService.applyDump(serverId, dump(20, 30));
    expect(totals()).toEqual({ total_rx: 170, total_tx: 1530 });
  });
});
