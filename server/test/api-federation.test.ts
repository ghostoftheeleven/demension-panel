import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDatabase } from '../src/db/index.js';
import { AuthService } from '../src/services/auth.service.js';
import { AwgService } from '../src/services/awg.service.js';
import { startTestServer } from './test-app.js';

describe('API: Федерация и партнёрский доступ (интеграционное тестирование)', () => {
  let testEnv: Awaited<ReturnType<typeof startTestServer>>;
  let adminToken: string;
  let serverId: number;

  beforeAll(async () => {
    initDatabase();
    AuthService.resetAdmin('admin_fed_test', 'TestPassword123!');
    const login = AuthService.login('admin_fed_test', 'TestPassword123!');
    adminToken = login!.token;
    testEnv = await startTestServer();

    // Создаём ноду
    const res = await testEnv.request('/api/servers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Нода для партнёров',
        host: '198.51.100.99',
        ssh_port: 22,
        ssh_password: 'test-ssh-password',
        awg_port: 51820,
        subnet: '10.15.0.1/24',
      }),
    });
    const s = await res.json();
    serverId = s.id;
    db.prepare("UPDATE servers SET status = 'online' WHERE id = ?").run(serverId);
  });

  afterAll(async () => {
    await testEnv.close();
  });

  const adminHeaders = () => ({
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  });

  let partnerId: number;
  let partnerToken: string;

  it('создаёт партнёра с ограничением по числу клиентов и привязкой к ноде', async () => {
    const res = await testEnv.request('/api/partners', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        name: 'VPN-Партнёр',
        node_ids: [serverId],
        max_clients: 2,
        traffic_limit: 5 * 1024 * 1024 * 1024,
      }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    partnerId = data.partner.id;
    partnerToken = data.token;

    expect(data.partner.name).toBe('VPN-Партнёр');
    expect(partnerToken).toMatch(/^dp_[A-Za-z0-9_-]+$/);
    expect(data.connect_string).toContain(partnerToken);
    expect(data.partner.max_clients).toBe(2);
    expect(data.partner.node_ids).toEqual([serverId]);
  });

  it('отклоняет запросы по HTTP, если не задан ALLOW_INSECURE_FEDERATION', async () => {
    delete process.env.ALLOW_INSECURE_FEDERATION;
    const res = await testEnv.request('/api/federation/v1/info', {
      headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(res.status).toBe(403);
    const err = await res.json();
    expect(err.error).toContain('HTTPS');
  });

  it('при ALLOW_INSECURE_FEDERATION=1 пропускает запрос с валидным Bearer-токеном', async () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';

    // С неверным токеном -> 401
    const badRes = await testEnv.request('/api/federation/v1/info', {
      headers: { Authorization: 'Bearer dp_badtoken0000000000000000000000000000000000000000000' },
    });
    expect(badRes.status).toBe(401);

    // С правильным токеном -> 200
    const res = await testEnv.request('/api/federation/v1/info', {
      headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.partner_name).toBe('VPN-Партнёр');
    expect(data.limits.max_clients).toBe(2);
  });

  it('возвращает список разрешённых для партнёра нод без серверных секретов', async () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';
    const res = await testEnv.request('/api/federation/v1/nodes', {
      headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(res.status).toBe(200);
    const { nodes } = await res.json();
    expect(nodes).toHaveLength(1);
    const node = nodes[0];
    expect(node.id).toBe(serverId);
    expect(node.name).toBe('Нода для партнёров');
    expect(node.host).toBe('198.51.100.99');
    expect(node.params.awg_version).toBe(3);
    expect(node.public_key).toBeTruthy();

    // Секреты ноды не раскрываются
    expect(node.server_private_key).toBeUndefined();
    expect(node.ssh_password).toBeUndefined();
    expect(node.ssh_key).toBeUndefined();
  });

  let peer1Id: number;
  let peer2Id: number;

  it('позволяет партнёру регистрировать клиентов и соблюдает лимит max_clients', async () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';
    const fedHeaders = {
      Authorization: `Bearer ${partnerToken}`,
      'Content-Type': 'application/json',
    };

    const kp1 = AwgService.generateKeyPair();
    const res1 = await testEnv.request('/api/federation/v1/peers', {
      method: 'POST',
      headers: fedHeaders,
      body: JSON.stringify({
        node_id: serverId,
        public_key: kp1.publicKey,
        name: 'Партнёрский Клиент #1',
      }),
    });
    expect(res1.status).toBe(201);
    const { peer: p1 } = await res1.json();
    peer1Id = p1.id;
    expect(p1.client_ip).toBe('10.15.0.2');
    expect(p1.public_key).toBe(kp1.publicKey);
    expect(p1.preshared_key).toBeTruthy();

    const kp2 = AwgService.generateKeyPair();
    const res2 = await testEnv.request('/api/federation/v1/peers', {
      method: 'POST',
      headers: fedHeaders,
      body: JSON.stringify({
        node_id: serverId,
        public_key: kp2.publicKey,
        name: 'Партнёрский Клиент #2',
      }),
    });
    expect(res2.status).toBe(201);
    const { peer: p2 } = await res2.json();
    peer2Id = p2.id;
    expect(p2.client_ip).toBe('10.15.0.3');

    // Третий клиент превышает max_clients: 2 -> 403
    const kp3 = AwgService.generateKeyPair();
    const res3 = await testEnv.request('/api/federation/v1/peers', {
      method: 'POST',
      headers: fedHeaders,
      body: JSON.stringify({
        node_id: serverId,
        public_key: kp3.publicKey,
        name: 'Партнёрский Клиент #3',
      }),
    });
    expect(res3.status).toBe(403);
    const err3 = await res3.json();
    expect(err3.error).toContain('лимит клиентов');
  });

  it('записывает аудит действий партнёра', async () => {
    const auditRes = await testEnv.request(`/api/partners/${partnerId}/audit`, {
      headers: adminHeaders(),
    });
    expect(auditRes.status).toBe(200);
    const audit = await auditRes.json();
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.some((a: any) => a.action === 'peer_created')).toBe(true);
  });

  it('позволяет партнёру удалять свои пиры', async () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';
    const delRes = await testEnv.request(`/api/federation/v1/peers/${peer1Id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(delRes.status).toBe(200);
    const delData = await delRes.json();
    expect(delData.success).toBe(true);
  });

  it('отключение партнёра блокирует дальнейший доступ к федерации', async () => {
    process.env.ALLOW_INSECURE_FEDERATION = '1';
    // Администратор отключает доступ партнёра
    const disableRes = await testEnv.request(`/api/partners/${partnerId}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);

    // Запрос к федерации теперь отдаёт 403
    const fedRes = await testEnv.request('/api/federation/v1/nodes', {
      headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(fedRes.status).toBe(403);
    const err = await fedRes.json();
    expect(err.error).toContain('отключён');
  });
});
