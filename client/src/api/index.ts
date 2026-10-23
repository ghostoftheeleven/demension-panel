import type { Server, Client, QrCodeData } from '../types';

const API_BASE = '/api';

export const api = {
  // Servers
  async getServers(): Promise<Server[]> {
    const res = await fetch(`${API_BASE}/servers`);
    if (!res.ok) throw new Error('Ошибка загрузки серверов');
    return res.json();
  },

  async getServer(id: number): Promise<Server> {
    const res = await fetch(`${API_BASE}/servers/${id}`);
    if (!res.ok) throw new Error('Ошибка загрузки сервера');
    return res.json();
  },

  async createServer(data: Partial<Server> & { ssh_password?: string; ssh_key?: string }): Promise<Server> {
    const res = await fetch(`${API_BASE}/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Ошибка добавления сервера');
    }
    return res.json();
  },

  async updateServer(id: number, data: Partial<Server>): Promise<Server> {
    const res = await fetch(`${API_BASE}/servers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Ошибка обновления сервера');
    return res.json();
  },

  async deleteServer(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Ошибка удаления сервера');
  },

  async testSsh(id: number): Promise<{ success: boolean; message?: string }> {
    const res = await fetch(`${API_BASE}/servers/${id}/test-ssh`, { method: 'POST' });
    return res.json();
  },

  async randomizeParams(id: number): Promise<Server> {
    const res = await fetch(`${API_BASE}/servers/${id}/randomize-params`, { method: 'POST' });
    if (!res.ok) throw new Error('Ошибка рандомизации параметров');
    return res.json();
  },

  async syncServer(id: number): Promise<{ success: boolean; error?: string }> {
    const res = await fetch(`${API_BASE}/servers/${id}/sync`, { method: 'POST' });
    return res.json();
  },

  // Clients
  async getClients(serverId: number): Promise<Client[]> {
    const res = await fetch(`${API_BASE}/servers/${serverId}/clients`);
    if (!res.ok) throw new Error('Ошибка загрузки клиентов');
    return res.json();
  },

  async createClient(serverId: number, name?: string): Promise<Client> {
    const res = await fetch(`${API_BASE}/servers/${serverId}/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Ошибка создания клиента');
    }
    return res.json();
  },

  async updateClient(id: number, data: Partial<Client>): Promise<Client> {
    const res = await fetch(`${API_BASE}/clients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Ошибка обновления клиента');
    return res.json();
  },

  async deleteClient(id: number): Promise<void> {
    const res = await fetch(`${API_BASE}/clients/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Ошибка удаления клиента');
  },

  async getClientQr(id: number): Promise<QrCodeData> {
    const res = await fetch(`${API_BASE}/clients/${id}/qrcode`);
    if (!res.ok) throw new Error('Ошибка получения QR-кода');
    return res.json();
  },

  getClientConfigUrl(id: number): string {
    return `${API_BASE}/clients/${id}/config`;
  },
};
