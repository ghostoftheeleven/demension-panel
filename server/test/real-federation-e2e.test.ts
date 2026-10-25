import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AwgService } from '../src/services/awg.service.js';
import { eventually, startPanel, type PanelProcess } from './helpers/panel-process.js';

/**
 * Сквозной сценарий партнёрского доступа на трёх уровнях: панель-получатель → панель-владелец → настоящая нода в Docker.
 * Обе панели — отдельные процессы с собственными БД. Без запущенного Docker-узла (SSH на 2222) тесты пропускаются.
 */

const NODE_CONTAINER = 'dementia-node-1';
const SSH_PORT = 2222;

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const dockerNodeAvailable = await isPortOpen(SSH_PORT);

/** Состояние интерфейса awg0 внутри контейнера AmneziaWG на тестовой ноде */
const awgShow = (): string => {
  try {
    return execFileSync('docker', ['exec', NODE_CONTAINER, 'docker', 'exec', 'amnezia-awg', 'awg', 'show', 'awg0'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
};

describe.skipIf(!dockerNodeAvailable)('Партнёрский доступ: получатель → владелец → Docker-нода', () => {
  let owner: PanelProcess;
  let receiver: PanelProcess;
  let ownerNodeId: number;
  let partnerId: number;
  let remotePanelId: number;
  let remoteServerId: number;
  let subscriberId: number;
  let subscriptionToken: string;
  let clientPublicKey: string;

  const subscription = async (token = subscriptionToken) => {
    const reply = await receiver.request({ path: `/sub/${token}?format=json` });
    return { status: reply.status, body: reply.status === 200 ? JSON.parse(reply.body) : null };
  };
  const decodeConfigs = (body: any): string[] => body.servers.map((s: any) => Buffer.from(s.config, 'base64url').toString('utf-8'));
  const ownerClients = async () => (await owner.api(`/api/partners/${partnerId}/clients`)).body as any[];
  const syncReceiver = () => receiver.api(`/api/remote-panels/${remotePanelId}/sync`, 'POST');

  beforeAll(async () => {
    [owner, receiver] = await Promise.all([startPanel({ ALLOW_INSECURE_FEDERATION: '1' }), startPanel({ ALLOW_INSECURE_FEDERATION: '1' })]);
  }, 120000);

  afterAll(async () => {
    if (owner) {
      await owner.api(`/api/servers/${ownerNodeId}?teardown=1&force=1`, 'DELETE').catch(() => {});
    }
    await Promise.all([owner?.stop(), receiver?.stop()]);
  }, 120000);

  it('владелец устанавливает AmneziaWG на ноду через WebSocket панели', async () => {
    const created = await owner.api('/api/servers', 'POST', {
      name: 'Нода владельца', host: '127.0.0.1', ssh_port: SSH_PORT, ssh_password: 'rootpass123', awg_port: 51820, subnet: '10.40.0.1/24',
    });
    expect(created.status).toBe(201);
    ownerNodeId = created.body.id;

    const result = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${owner.port}/ws`);
      const timer = setTimeout(() => reject(new Error('установка не завершилась за 4 минуты')), 240000);
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: owner.token })));
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'auth_ok') ws.send(JSON.stringify({ type: 'start_install', serverId: ownerNodeId }));
        if (message.type === 'install_finished') {
          clearTimeout(timer);
          ws.close();
          resolve(message.result);
        }
      });
    });

    expect(result).toEqual({ success: true });
    expect((await owner.api(`/api/servers/${ownerNodeId}`)).body.status).toBe('online');
    expect(awgShow()).toContain('interface: awg0');
  }, 300000);

  it('владелец выдаёт партнёру доступ к ноде и строку подключения', async () => {
    const created = await owner.api('/api/partners', 'POST', { name: 'Панель-получатель', node_ids: [ownerNodeId], max_clients: 5 });
    expect(created.status).toBe(201);
    partnerId = created.body.partner.id;
    expect(created.body.connect_string).toBe(`http://127.0.0.1:${owner.port}#${created.body.token}`);

    const connected = await receiver.api('/api/remote-panels', 'POST', { connect_string: created.body.connect_string, name: 'Владелец' });
    expect(connected.status).toBe(201);
    expect(connected.body).toMatchObject({ status: 'online', partner_name: 'Панель-получатель', node_count: 1, last_error: null });
    remotePanelId = connected.body.id;

    const servers = (await receiver.api('/api/servers')).body as any[];
    const remote = servers.find((s) => s.remote_panel_id === remotePanelId)!;
    expect(remote).toMatchObject({ name: 'Нода владельца', status: 'online', awg_version: 3, remote_panel_name: 'Владелец' });
    expect(JSON.stringify(remote)).not.toMatch(/"(server_private_key|ssh_password|ssh_key|preshared_key)"/);
    remoteServerId = remote.id;
  });

  it('пользователь получателя на ноде партнёра получает рабочий конфиг, а пир появляется на настоящей ноде', async () => {
    const created = await receiver.api('/api/subscribers', 'POST', { name: 'Fed user', server_ids: [remoteServerId] });
    expect(created.status).toBe(201);
    subscriberId = created.body.id;
    subscriptionToken = created.body.token;

    const sub = await subscription();
    expect(sub.status).toBe(200);
    const [conf] = decodeConfigs(sub.body);
    const ownerServer = (await owner.api(`/api/servers/${ownerNodeId}`)).body;
    expect(conf).toContain('Address = 10.40.0.2/32');
    expect(conf).toContain('Endpoint = 127.0.0.1:51820');
    expect(conf).toContain(`H1 = ${ownerServer.h1}`);
    expect(conf).toMatch(/PresharedKey = \S{44}/);
    expect(conf).toMatch(/PublicKey = \S{44}/);
    clientPublicKey = AwgService.derivePublicKey(/PrivateKey = (\S+)/.exec(conf)![1]);

    await eventually(() => expect(awgShow()).toContain(clientPublicKey));
    expect(awgShow()).toContain('10.40.0.2/32');

    // Приватного ключа клиента у владельца нет
    const [peer] = await ownerClients();
    expect(peer).toMatchObject({ name: 'Fed user (Нода владельца)', client_ip: '10.40.0.2', enabled: true, owner_blocked: false });
    expect(JSON.stringify(peer)).not.toContain('PrivateKey');
  }, 60000);

  it('переименование у получателя доходит до владельца', async () => {
    expect((await receiver.api(`/api/subscribers/${subscriberId}`, 'PUT', { name: 'Fed user renamed' })).status).toBe(200);
    // Ответ уходит после синхронизации с владельцем — ждать фонового цикла (раз в минуту) не нужно
    expect((await ownerClients())[0].name).toBe('Fed user renamed (Нода владельца)');
  }, 30000);

  it('отключение пользователя снимает пир с ноды, включение возвращает', async () => {
    await receiver.api(`/api/subscribers/${subscriberId}`, 'PUT', { enabled: false });
    await eventually(() => expect(awgShow()).not.toContain(clientPublicKey));
    expect((await ownerClients())[0].enabled).toBe(false);
    expect((await subscription()).status).toBe(403);

    await receiver.api(`/api/subscribers/${subscriberId}`, 'PUT', { enabled: true });
    await eventually(() => expect(awgShow()).toContain(clientPublicKey));
    expect((await ownerClients())[0].enabled).toBe(true);
  }, 60000);

  it('блокировка владельцем убирает пир с ноды и ноду из подписки; снятие блокировки возвращает', async () => {
    const [peer] = await ownerClients();
    expect((await owner.api(`/api/clients/${peer.id}`, 'PUT', { enabled: false })).body.owner_blocked).toBe(true);
    await eventually(() => expect(awgShow()).not.toContain(clientPublicKey));

    await syncReceiver();
    expect(decodeConfigs((await subscription()).body)).toHaveLength(0);

    await owner.api(`/api/clients/${peer.id}`, 'PUT', { enabled: true });
    await eventually(() => expect(awgShow()).toContain(clientPublicKey));
    await syncReceiver();
    expect(decodeConfigs((await subscription()).body)).toHaveLength(1);
  }, 90000);

  it('перевыпуск ссылки меняет ключи: новый пир на ноде, старый удалён, подписка сразу содержит ноду', async () => {
    const reset = await receiver.api(`/api/subscribers/${subscriberId}/reset-token`, 'POST');
    expect(reset.status).toBe(200);
    expect((await subscription()).status).toBe(404); // прежняя ссылка недействительна

    const next = await subscription(reset.body.token);
    expect(next.status).toBe(200);
    const [conf] = decodeConfigs(next.body); // ответ ушёл после синхронизации — нода уже в подписке
    const newKey = AwgService.derivePublicKey(/PrivateKey = (\S+)/.exec(conf)![1]);
    expect(newKey).not.toBe(clientPublicKey);

    await eventually(() => {
      const shown = awgShow();
      expect(shown).toContain(newKey);
      expect(shown).not.toContain(clientPublicKey);
    });
    expect((await ownerClients())).toHaveLength(1);
    subscriptionToken = reset.body.token;
    clientPublicKey = newKey;
  }, 90000);

  it('удаление пользователя удаляет клиента у владельца и пир на ноде', async () => {
    expect((await receiver.api(`/api/subscribers/${subscriberId}`, 'DELETE')).status).toBe(200);
    expect(await ownerClients()).toHaveLength(0); // ответ ушёл после синхронизации с владельцем
    await eventually(() => expect(awgShow()).not.toContain(clientPublicKey));
  }, 60000);

  it('лимит клиентов партнёра соблюдается владельцем', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      const created = await receiver.api('/api/subscribers', 'POST', { name: `limit-${i}`, server_ids: [remoteServerId] });
      results.push(created.status);
    }
    expect(results.every((status) => status === 201)).toBe(true);
    // Шестой клиент не прошёл у владельца: у получателя он остаётся «ожидающим», а у владельца — ровно max_clients
    expect(await ownerClients()).toHaveLength(5);
    const clients = (await receiver.api(`/api/servers/${remoteServerId}/clients`)).body as any[];
    expect(clients.filter((c) => c.pending)).toHaveLength(1);
    expect(clients.find((c) => c.pending).remote_state).toContain('лимит клиентов');
  }, 120000);

  it('отзыв доступа владельцем: панель получателя помечается revoked, ноды пропадают из подписок', async () => {
    await owner.api(`/api/partners/${partnerId}`, 'PUT', { enabled: false });
    const panel = (await syncReceiver()).body;
    expect(panel.status).toBe('revoked');
    expect(((await receiver.api(`/api/servers/${remoteServerId}`)).body.status)).toBe('uninstalled');
    await eventually(() => expect(awgShow()).not.toMatch(/peer: /));
  }, 60000);

  it('отключение панели у получателя удаляет её ноды и клиентов', async () => {
    await owner.api(`/api/partners/${partnerId}`, 'PUT', { enabled: true });
    expect((await receiver.api(`/api/remote-panels/${remotePanelId}`, 'DELETE')).body.success).toBe(true);
    expect((await receiver.api('/api/servers')).body.filter((s: any) => s.remote_panel_id)).toHaveLength(0);
  }, 60000);
});
