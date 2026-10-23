import type { Server, Client, QrCodeData, Subscriber, AdminUser } from '../types';

const API_BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('demension_token');
}

export function setToken(token: string) {
  localStorage.setItem('demension_token', token);
}

export function clearToken() {
  localStorage.removeItem('demension_token');
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers || {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('auth_unauthorized'));
  }

  return res;
}

export const api = {
  // Auth
  async login(username: string, password: string): Promise<{ token: string; user: AdminUser }> {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Ошибка входа');
    }
    const data = await res.json();
    setToken(data.token);
    return data;
  },

  async me(): Promise<{ user: AdminUser }> {
    const res = await fetchWithAuth(`${API_BASE}/auth/me`);
    if (!res.ok) throw new Error('Не авторизован');
    return res.json();
  },

  async logout(): Promise<void> {
    await fetchWithAuth(`${API_BASE}/auth/logout`, { method: 'POST' });
    clearToken();
  },

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const res = await fetchWithAuth(`${API_BASE}/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Ошибка смены пароля');
    }
  },

  // Servers
  async getServers(): Promise<Server[]> {
    const res = await fetchWithAuth(`${API_BASE}/servers`);
    if (!res.ok) throw new Error('Ошибка загрузки серверов');
    return res.json();
  },

  async getServer(id: number): Promise<Server> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}`);
    if (!res.ok) throw new Error('Ошибка загрузки сервера');
    return res.json();
  },

  async createServer(data: Partial<Server> & { ssh_password?: string; ssh_key?: string }): Promise<Server> {
    const res = await fetchWithAuth(`${API_BASE}/servers`, {
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
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Ошибка обновления сервера');
    return res.json();
  },

  async deleteServer(id: number): Promise<void> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Ошибка удаления сервера');
  },

  async testSsh(id: number): Promise<{ success: boolean; message?: string }> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}/test-ssh`, { method: 'POST' });
    return res.json();
  },

  async randomizeParams(id: number): Promise<Server> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}/randomize-params`, { method: 'POST' });
    if (!res.ok) throw new Error('Ошибка рандомизации параметров');
    return res.json();
  },

  async syncServer(id: number): Promise<{ success: boolean; error?: string }> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${id}/sync`, { method: 'POST' });
    return res.json();
  },

  // Standalone Clients
  async getClients(serverId: number): Promise<Client[]> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${serverId}/clients`);
    if (!res.ok) throw new Error('Ошибка загрузки клиентов');
    return res.json();
  },

  async createClient(serverId: number, name?: string): Promise<Client> {
    const res = await fetchWithAuth(`${API_BASE}/servers/${serverId}/clients`, {
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
    const res = await fetchWithAuth(`${API_BASE}/clients/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Ошибка обновления клиента');
    return res.json();
  },

  async deleteClient(id: number): Promise<void> {
    const res = await fetchWithAuth(`${API_BASE}/clients/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Ошибка удаления клиента');
  },

  async getClientQr(id: number): Promise<QrCodeData> {
    const res = await fetchWithAuth(`${API_BASE}/clients/${id}/qrcode`);
    if (!res.ok) throw new Error('Ошибка получения QR-кода');
    return res.json();
  },

  getClientConfigUrl(id: number): string {
    const token = getToken();
    return `${API_BASE}/clients/${id}/config${token ? `?token=${token}` : ''}`;
  },

  // Subscribers (Users with multi-node access and HAPP/Incy subscriptions)
  async getSubscribers(): Promise<Subscriber[]> {
    const res = await fetchWithAuth(`${API_BASE}/subscribers`);
    if (!res.ok) throw new Error('Ошибка загрузки подписчиков');
    return res.json();
  },

  async createSubscriber(data: { name: string; server_ids: number[] }): Promise<Subscriber> {
    const res = await fetchWithAuth(`${API_BASE}/subscribers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Ошибка создания пользователя');
    }
    return res.json();
  },

  async updateSubscriber(id: number, data: Partial<Subscriber>): Promise<Subscriber> {
    const res = await fetchWithAuth(`${API_BASE}/subscribers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Ошибка обновления пользователя');
    return res.json();
  },

  async deleteSubscriber(id: number): Promise<void> {
    const res = await fetchWithAuth(`${API_BASE}/subscribers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Ошибка удаления пользователя');
  },

  async resetSubscriberToken(id: number): Promise<{ token: string }> {
    const res = await fetchWithAuth(`${API_BASE}/subscribers/${id}/reset-token`, { method: 'POST' });
    if (!res.ok) throw new Error('Ошибка обновления токена');
    return res.json();
  },

  getSubscriptionUrl(token: string): string {
    const origin = window.location.origin;
    return `${origin}/sub/${token}`;
  },
};
