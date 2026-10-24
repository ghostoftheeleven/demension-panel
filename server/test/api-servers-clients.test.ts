import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { startTestServer } from './test-app.js';

describe('API: Серверы и клиенты (интеграционное тестирование)', () => {
  let testEnv: Awaited<ReturnType<typeof startTestServer>>;
  let adminToken: string;

  beforeAll(async () => {
    initDatabase();
    AuthService.resetAdmin('admin_api_test', 'TestPassword123!');
    const login = AuthService.login('admin_api_test', 'TestPassword123!');
    adminToken = login!.token;
    testEnv = await startTestServer();
  });

  afterAll(async () => {
    await testEnv.close();
  });

  const authHeaders = () => ({
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  });

  it('маршруты серверов требуют авторизации', async () => {
    const unauthGet = await testEnv.request('/api/servers');
    expect(unauthGet.status).toBe(401);

    const unauthPost = await testEnv.request('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', host: '1.2.3.4' }),
    });
    expect(unauthPost.status).toBe(401);
  });

  let createdServerId: number;

  it('создаёт сервер с параметрами AWG 3.x и НЕ отдаёт секреты в JSON', async () => {
    const res = await testEnv.request('/api/servers', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'Тестовый сервер 1',
        host: '198.51.100.10',
        ssh_port: 22,
        ssh_user: 'root',
        ssh_password: 'super-ssh-password',
        awg_port: 51820,
        subnet: '10.8.0.1/24',
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    createdServerId = data.id;

    expect(data.name).toBe('Тестовый сервер 1');
    expect(data.host).toBe('198.51.100.10');
    expect(data.awg_version).toBe(3);
    expect(data.has_ssh_password).toBe(true);
    expect(data.has_ssh_key).toBe(false);

    // Критический инвариант #1: Секреты никогда не отдаются в API
    expect(data.ssh_password).toBeUndefined();
    expect(data.ssh_key).toBeUndefined();
    expect(data.server_private_key).toBeUndefined();
    expect(data.preshared_key).toBeUndefined();
    expect(data.extra_params).toEqual({});

    // Параметры обфускации AWG 3.x сгенерированы
    expect(data.s1).toBeGreaterThanOrEqual(12);
    expect(data.s2).toBeGreaterThanOrEqual(12);
    expect(data.s3).toBeGreaterThanOrEqual(12);
    expect(data.s4).toBeGreaterThanOrEqual(12);
    expect(data.s4).toBeLessThanOrEqual(32);
    expect(data.header_protection_key).toBeTruthy();
  });

  it('валидирует входные данные сервера', async () => {
    // Неверный хост
    const badHost = await testEnv.request('/api/servers', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Bad', host: 'invalid; host' }),
    });
    expect(badHost.status).toBe(400);

    // Неверный порт
    const badPort = await testEnv.request('/api/servers', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Bad', host: '1.2.3.4', awg_port: 99999 }),
    });
    expect(badPort.status).toBe(400);

    // Неверная подсеть
    const badSubnet = await testEnv.request('/api/servers', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Bad', host: '1.2.3.4', subnet: '300.0.0.1/24' }),
    });
    expect(badSubnet.status).toBe(400);
  });

  it('обновляет метаданные сервера', async () => {
    const res = await testEnv.request(`/api/servers/${createdServerId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'Германия #1',
        host: '198.51.100.20',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('Германия #1');
    expect(data.host).toBe('198.51.100.20');

    // Настройка отображения в подписке (sub_name, sub_order) через /api/subscription-settings
    const subSettingsRes = await testEnv.request('/api/subscription-settings', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        servers: [{ id: createdServerId, sub_name: '🇩🇪 Франкфурт', sub_order: 10 }],
      }),
    });
    expect(subSettingsRes.status).toBe(200);

    const getRes = await testEnv.request(`/api/servers/${createdServerId}`, {
      headers: authHeaders(),
    });
    const updated = await getRes.json();
    expect(updated.sub_name).toBe('🇩🇪 Франкфурт');
    expect(updated.sub_order).toBe(10);
  });

  it('валидирует и обновляет параметры обфускации', async () => {
    // Попытка задать невалидные параметры: S1 + 56 = S2
    const invalidRes = await testEnv.request(`/api/servers/${createdServerId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        s1: 20,
        s2: 76, // 20 + 56 = 76 — недопустимо
      }),
    });
    expect(invalidRes.status).toBe(400);
    const err = await invalidRes.json();
    expect(err.error).toMatch(/S1 \+ 56/);

    // Рандомизация параметров
    const randRes = await testEnv.request(`/api/servers/${createdServerId}/randomize-params`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(randRes.status).toBe(200);
    const randData = await randRes.json();
    expect(randData.header_protection_key).toBeTruthy();
  });

  let client1Id: number;
  let client2Id: number;

  it('создаёт клиентов с авто-выделением адресов и защитой приватного ключа', async () => {
    // Первый клиент -> .2
    const res1 = await testEnv.request(`/api/servers/${createdServerId}/clients`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Клиент 1' }),
    });
    expect(res1.status).toBe(201);
    const c1 = await res1.json();
    client1Id = c1.id;
    expect(c1.name).toBe('Клиент 1');
    expect(c1.client_ip).toBe('10.8.0.2');
    expect(c1.client_private_key).toBeUndefined(); // Секрет не отдаётся!

    // Второй клиент -> .3
    const res2 = await testEnv.request(`/api/servers/${createdServerId}/clients`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Клиент 2' }),
    });
    expect(res2.status).toBe(201);
    const c2 = await res2.json();
    client2Id = c2.id;
    expect(c2.client_ip).toBe('10.8.0.3');
    expect(c2.client_private_key).toBeUndefined();

    // Список клиентов
    const listRes = await testEnv.request(`/api/servers/${createdServerId}/clients`, {
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toHaveLength(2);
    for (const item of list) {
      expect(item.client_private_key).toBeUndefined();
    }
  });

  it('отдаёт файл конфигурации .conf с приватным ключом клиента и параметрами обфускации', async () => {
    const res = await testEnv.request(`/api/clients/${client1Id}/config`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const config = await res.text();
    expect(config).toContain('[Interface]');
    expect(config).toContain('PrivateKey =');
    expect(config).toContain('Address = 10.8.0.2/32');
    expect(config).toContain('[Peer]');
    expect(config).toContain('Endpoint = 198.51.100.20:51820');
    expect(config).toContain('Jc =');
    expect(config).toContain('S1 =');
    expect(config).toContain('HeaderProtectionKey =');
  });

  it('генерирует валидный QR-код', async () => {
    const res = await testEnv.request(`/api/clients/${client1Id}/qrcode`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.qrcode).toMatch(/^data:image\/png;base64,/);
    expect(data.config).toContain('Address = 10.8.0.2/32');
    expect(data.clientName).toBe('Клиент 1');
  });

  it('позволяет отключать, переименовывать и удалять клиентов', async () => {
    // Отключение
    const disableRes = await testEnv.request(`/api/clients/${client1Id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);
    expect((await disableRes.json()).enabled).toBe(0);

    // Удаление первого клиента
    const delRes = await testEnv.request(`/api/clients/${client1Id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(delRes.status).toBe(200);

    // Повторное скачивание конфига удалённого клиента возвращает 404
    const config404 = await testEnv.request(`/api/clients/${client1Id}/config`, {
      headers: authHeaders(),
    });
    expect(config404.status).toBe(404);
  });

  it('удаляет сервер и связанные с ним записи', async () => {
    const del = await testEnv.request(`/api/servers/${createdServerId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(del.status).toBe(200);

    const get404 = await testEnv.request(`/api/servers/${createdServerId}`, {
      headers: authHeaders(),
    });
    expect(get404.status).toBe(404);
  });
});
