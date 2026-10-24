import { beforeAll, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { generatePartnerToken, hashPartnerToken, PartnerService } from '../src/services/partner.service.js';
import { isPendingIp, parseConnectString, pendingIp } from '../src/services/federation-client.service.js';
import { ProvisionService } from '../src/services/provision.service.js';

beforeAll(() => {
  initDatabase();
});

describe('строка подключения партнёра', () => {
  it('разбирает адрес и токен', () => {
    const { token } = generatePartnerToken();
    expect(parseConnectString(`https://panel.example.com/#${token}`)).toEqual({ baseUrl: 'https://panel.example.com', token });
    expect(parseConnectString(`https://panel.example.com:8443#${token}`).baseUrl).toBe('https://panel.example.com:8443');
  });

  it('требует HTTPS и корректный токен', () => {
    const { token } = generatePartnerToken();
    expect(() => parseConnectString(`http://panel.example.com#${token}`)).toThrow(/HTTPS/);
    expect(() => parseConnectString('https://panel.example.com#bad')).toThrow(/токен/);
    expect(() => parseConnectString(token)).toThrow();
  });
});

describe('токены партнёров', () => {
  it('в БД хранится только хэш, поиск работает по токену', () => {
    const { token, hash, hint } = generatePartnerToken();
    expect(hash).toBe(hashPartnerToken(token));
    expect(hint).not.toContain(token.slice(10, 30));
    db.prepare("INSERT INTO partners (name, token_hash, token_hint) VALUES ('p', ?, ?)").run(hash, hint);
    expect(PartnerService.findByToken(token)?.name).toBe('p');
    expect(PartnerService.findByToken(token + 'x')).toBeNull();
    expect(PartnerService.findByToken('wrong')).toBeNull();
  });
});

describe('активность клиентов партнёра на ноде', () => {
  it('клиент активен, только пока доступ включён, нода не отозвана и владелец не заблокировал', () => {
    const server = Number(db.prepare("INSERT INTO servers (name, host, status) VALUES ('n', '1.1.1.1', 'online')").run().lastInsertRowid);
    const { hash, hint } = generatePartnerToken();
    const partner = Number(db.prepare("INSERT INTO partners (name, token_hash, token_hint) VALUES ('q', ?, ?)").run(hash, hint).lastInsertRowid);
    db.prepare('INSERT INTO partner_nodes (partner_id, server_id) VALUES (?, ?)').run(partner, server);
    const client = Number(
      db.prepare(`
        INSERT INTO clients (server_id, partner_id, name, client_ip, client_public_key, client_private_key)
        VALUES (?, ?, 'c', '10.8.0.2', 'PUB', '')
      `).run(server, partner).lastInsertRowid
    );
    const active = () => ProvisionService.getServerClients(server).find((c) => c.id === client).subscriber_active;

    expect(active()).toBe(1);
    db.prepare('UPDATE clients SET owner_blocked = 1 WHERE id = ?').run(client);
    expect(active()).toBe(0);
    db.prepare('UPDATE clients SET owner_blocked = 0 WHERE id = ?').run(client);
    db.prepare('UPDATE partners SET suspended = 1 WHERE id = ?').run(partner);
    expect(active()).toBe(0);
    db.prepare('UPDATE partners SET suspended = 0, enabled = 0 WHERE id = ?').run(partner);
    expect(active()).toBe(0);
    db.prepare('UPDATE partners SET enabled = 1 WHERE id = ?').run(partner);
    db.prepare('DELETE FROM partner_nodes WHERE partner_id = ?').run(partner);
    expect(active()).toBe(0);
  });

  it('временные адреса клиентов на нодах партнёра уникальны', () => {
    const a = pendingIp();
    expect(isPendingIp(a)).toBe(true);
    expect(a).not.toBe(pendingIp());
    expect(isPendingIp('10.8.0.2')).toBe(false);
  });
});
