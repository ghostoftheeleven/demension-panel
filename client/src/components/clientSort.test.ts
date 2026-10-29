import { describe, it, expect } from 'vitest';
import type { Client } from '../types';
import { clientStatus, sortClients } from './clientSort';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

const c = (id: number, patch: Partial<Client>): Client =>
  ({ id, name: `c${id}`, client_ip: `10.8.0.${id}`, enabled: 1, owner_blocked: false, total_rx: 0, total_tx: 0, last_handshake: null, ...patch }) as Client;

const names = (list: Client[]) => list.map((x) => x.name);

describe('clientStatus', () => {
  it('онлайн — рукопожатие не старше трёх минут; отключённые и заблокированные владельцем — disabled', () => {
    expect(clientStatus(c(1, { last_handshake: ago(179) }), NOW)).toBe('online');
    expect(clientStatus(c(1, { last_handshake: ago(181) }), NOW)).toBe('idle');
    expect(clientStatus(c(1, { last_handshake: null }), NOW)).toBe('idle');
    expect(clientStatus(c(1, { enabled: 0, last_handshake: ago(5) }), NOW)).toBe('disabled');
    expect(clientStatus(c(1, { owner_blocked: true, last_handshake: ago(5) }), NOW)).toBe('disabled');
  });
});

describe('sortClients', () => {
  it('IP сортируется как адрес: .10 идёт после .9', () => {
    const list = [c(10, { name: 'a' }), c(9, { name: 'b' }), c(100, { name: 'c' })];
    expect(names(sortClients(list, 'ip', 'asc', NOW))).toEqual(['b', 'a', 'c']);
    expect(names(sortClients(list, 'ip', 'desc', NOW))).toEqual(['c', 'a', 'b']);
  });

  it('имя — естественный порядок с числами, без учёта регистра', () => {
    const list = [c(1, { name: 'phone-10' }), c(2, { name: 'Phone-2' }), c(3, { name: 'alpha' })];
    expect(names(sortClients(list, 'name', 'asc', NOW))).toEqual(['alpha', 'Phone-2', 'phone-10']);
  });

  it('активность: никогда не подключавшиеся всегда внизу в любом направлении', () => {
    const list = [c(1, { name: 'never', last_handshake: null }), c(2, { name: 'old', last_handshake: ago(9000) }), c(3, { name: 'fresh', last_handshake: ago(5) })];
    expect(names(sortClients(list, 'activity', 'desc', NOW))).toEqual(['fresh', 'old', 'never']);
    expect(names(sortClients(list, 'activity', 'asc', NOW))).toEqual(['old', 'fresh', 'never']);
  });

  it('статус: онлайн, неактивные, отключённые', () => {
    const list = [
      c(1, { name: 'off', enabled: 0 }),
      c(2, { name: 'idle', last_handshake: ago(9000) }),
      c(3, { name: 'on', last_handshake: ago(10) }),
    ];
    expect(names(sortClients(list, 'status', 'asc', NOW))).toEqual(['on', 'idle', 'off']);
  });

  it('трафик — сумма загрузки и отдачи; равные значения упорядочены по имени, исходный массив не меняется', () => {
    const list = [c(1, { name: 'b', total_rx: 5, total_tx: 5 }), c(2, { name: 'a', total_rx: 10, total_tx: 0 }), c(3, { name: 'big', total_rx: 1, total_tx: 100 })];
    const copy = [...list];
    expect(names(sortClients(list, 'traffic', 'desc', NOW))).toEqual(['big', 'a', 'b']);
    expect(list).toEqual(copy);
  });
});
