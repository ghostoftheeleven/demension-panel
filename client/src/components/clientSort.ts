import type { Client } from '../types';

export type ClientSortKey = 'name' | 'ip' | 'status' | 'traffic' | 'activity';
export type SortDirection = 'asc' | 'desc';
export type ClientStatus = 'online' | 'idle' | 'disabled';

/** Клиент считается онлайн, если рукопожатие было не позднее трёх минут назад */
export const ONLINE_WINDOW_MS = 180_000;

export function clientStatus(client: Pick<Client, 'enabled' | 'owner_blocked' | 'last_handshake'>, now: number): ClientStatus {
  if (!client.enabled || client.owner_blocked) return 'disabled';
  if (client.last_handshake && now - new Date(client.last_handshake).getTime() < ONLINE_WINDOW_MS) return 'online';
  return 'idle';
}

const STATUS_ORDER: Record<ClientStatus, number> = { online: 0, idle: 1, disabled: 2 };

/** Адрес как число: «10.8.0.10» должен идти после «10.8.0.9» */
function ipValue(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + (Number(part) || 0), 0);
}

/** Сортировка без изменения исходного массива; при равенстве порядок определяет имя, чтобы список не «прыгал» при обновлении */
export function sortClients(clients: Client[], key: ClientSortKey, direction: SortDirection, now: number): Client[] {
  const sign = direction === 'asc' ? 1 : -1;
  const byName = (a: Client, b: Client) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' });
  const compare = (a: Client, b: Client): number => {
    switch (key) {
      case 'name':
        return byName(a, b);
      case 'ip':
        return ipValue(a.client_ip) - ipValue(b.client_ip);
      case 'status':
        return STATUS_ORDER[clientStatus(a, now)] - STATUS_ORDER[clientStatus(b, now)];
      case 'traffic':
        return a.total_rx + a.total_tx - (b.total_rx + b.total_tx);
      case 'activity': {
        // Никогда не подключавшиеся всегда внизу, в каком бы порядке ни шла сортировка
        const av = a.last_handshake ? new Date(a.last_handshake).getTime() : null;
        const bv = b.last_handshake ? new Date(b.last_handshake).getTime() : null;
        if (av === null && bv === null) return 0;
        if (av === null) return 1 / sign;
        if (bv === null) return -1 / sign;
        return av - bv;
      }
    }
  };
  return [...clients].sort((a, b) => sign * compare(a, b) || byName(a, b));
}
