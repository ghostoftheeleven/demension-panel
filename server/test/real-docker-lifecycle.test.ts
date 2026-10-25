import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Жизненный цикл ноды на настоящем Docker-узле (второй тестовый контейнер, SSH на 2223): переустановка, переход 1.x → 3.x,
 * объединение применений, смена порта, приостановка пользователя, проверка ключа SSH-хоста и повторное подключение.
 * Без запущенного узла тесты пропускаются.
 */

const SSH_PORT = 2223;

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

describe.skipIf(!dockerNodeAvailable)('Жизненный цикл ноды на реальном Docker-узле', () => {
  let tmpDir: string;
  let m: {
    db: any;
    ProvisionService: any;
    SshService: any;
    AwgService: any;
    SubscriptionService: any;
    paramsToColumns: any;
    insertClient: any;
    insertSubscriber: any;
  };
  let serverId: number;
  const clients: { id: number; publicKey: string; ip: string }[] = [];

  const server = () => m.db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  const ssh = (command: string) => m.SshService.executeCommand(m.ProvisionService.getCredentials(server()), command, { timeoutMs: 60000 });
  const awgShow = async () => (await ssh('docker exec amnezia-awg awg show awg0')).stdout as string;
  const containerStart = async () => ((await ssh("docker inspect -f '{{.State.StartedAt}}' amnezia-awg")).stdout as string).trim();
  const readConf = async () => (await ssh('docker exec amnezia-awg cat /opt/amnezia/awg/awg0.conf')).stdout as string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-docker-lifecycle-'));
    process.env.DEMENTIA_DATA_DIR = tmpDir;
    const dbModule = await import('../src/db/index.js');
    dbModule.initDatabase();
    const helpers = await import('./helpers/db.js');
    m = {
      db: dbModule.db,
      ProvisionService: (await import('../src/services/provision.service.js')).ProvisionService,
      SshService: (await import('../src/services/ssh.service.js')).SshService,
      AwgService: (await import('../src/services/awg.service.js')).AwgService,
      SubscriptionService: (await import('../src/services/subscription.service.js')).SubscriptionService,
      paramsToColumns: (await import('../src/utils/awg-params.js')).paramsToColumns,
      insertClient: helpers.insertClient,
      insertSubscriber: helpers.insertSubscriber,
    };
    // Сервер версии 1.x, ещё не установленный; доступ по паролю тестового узла
    serverId = helpers.insertServer({
      name: 'Docker lifecycle', host: '127.0.0.1', status: 'uninstalled', deployedPort: null, awgVersion: 1, sshPassword: 'rootpass123',
      subnet: '10.30.0.1/24', awgPort: 51820,
    });
    m.db.prepare('UPDATE servers SET ssh_port = ? WHERE id = ?').run(SSH_PORT, serverId);
    for (let i = 0; i < 2; i++) clients.push(m.insertClient(serverId, { ip: `10.30.0.${i + 2}`, name: `lifecycle-${i}` }));
  });

  afterAll(async () => {
    if (m && serverId) {
      try {
        await m.ProvisionService.teardown(serverId);
      } catch {
        // узел мог быть недоступен
      }
    }
    // На Windows открытый файл БД не даёт удалить каталог
    try {
      m?.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // временный каталог удалит система
    }
  });

  it('устанавливает AmneziaWG 1.x: оба клиента в интерфейсе, отпечаток SSH-хоста сохранён при первом подключении', async () => {
    const result = await m.ProvisionService.installServer(serverId);
    expect(result).toEqual({ success: true });

    const shown = await awgShow();
    for (const client of clients) expect(shown).toContain(client.publicKey);
    expect(shown).toMatch(/jc: \d+/);
    expect(shown).not.toMatch(/s3: /); // у 1.x нет S3
    expect(server().host_key).toMatch(/^SHA256:/);
    expect(await readConf()).not.toContain('S3 =');
  }, 180000);

  it('переустановка пересоздаёт контейнер, клиенты и ключ сервера сохраняются', async () => {
    const before = await containerStart();
    const publicKey = server().server_public_key;

    const result = await m.ProvisionService.requestReinstall(serverId);

    expect(result.success).toBe(true);
    expect(await containerStart()).not.toBe(before);
    expect(server().server_public_key).toBe(publicKey);
    const shown = await awgShow();
    for (const client of clients) expect(shown).toContain(client.publicKey);
    expect(shown).toContain(publicKey);
  }, 180000);

  it('переход на 3.x: новые параметры на ноде, клиенты на месте', async () => {
    const params = m.AwgService.generateRandomParams(3);
    const columns = m.paramsToColumns(params);
    m.db.prepare(`UPDATE servers SET ${Object.keys(columns).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(columns), serverId);

    const result = await m.ProvisionService.requestReinstall(serverId);

    expect(result.success).toBe(true);
    const conf = await readConf();
    expect(conf).toContain(`S3 = ${params.s3}`);
    expect(conf).toContain(`H1 = ${params.h1}`);
    expect(conf).toContain(`HeaderProtectionKey = ${params.header_protection_key}`);
    const shown = await awgShow();
    for (const client of clients) expect(shown).toContain(client.publicKey);
  }, 180000);

  it('одновременные применения параметров дают один перезапуск контейнера', async () => {
    const restarts = vi.spyOn(m.SshService, 'executeCommand');
    const before = await containerStart();
    m.db.prepare('UPDATE servers SET jc = 9 WHERE id = ?').run(serverId);
    restarts.mockClear();

    const results = await Promise.all([m.ProvisionService.requestApply(serverId), m.ProvisionService.requestApply(serverId), m.ProvisionService.requestApply(serverId)]);

    expect(results.every((r: any) => r.success)).toBe(true);
    const restartCalls = restarts.mock.calls.filter(([, command]) => String(command).includes('docker restart'));
    expect(restartCalls).toHaveLength(1);
    expect(await containerStart()).not.toBe(before);
    expect(await readConf()).toContain('Jc = 9');
    expect(server()).toMatchObject({ needs_apply: 0, last_error: null });
    restarts.mockRestore();
  }, 120000);

  it('смена порта пересоздаёт контейнер с новым пробросом UDP-порта', async () => {
    m.db.prepare('UPDATE servers SET awg_port = 51830 WHERE id = ?').run(serverId);

    const result = await m.ProvisionService.requestApply(serverId);

    expect(result.success).toBe(true);
    expect(server().deployed_port).toBe(51830);
    const ports = (await ssh('docker port amnezia-awg')).stdout as string;
    expect(ports).toContain('51830/udp');
    expect(ports).not.toContain('51820/udp');
    expect(await readConf()).toContain('ListenPort = 51830');
  }, 180000);

  it('приостановка пользователя снимает его клиентов с ноды, возобновление возвращает', async () => {
    const subscriberId = m.insertSubscriber({ name: 'Docker subscriber', expireAt: new Date(Date.now() + 3600_000).toISOString() });
    const peer = m.insertClient(serverId, { ip: '10.30.0.9', subscriberId, name: 'sub-peer' });
    await m.ProvisionService.requestSync(serverId);
    expect(await awgShow()).toContain(peer.publicKey);

    m.db.prepare("UPDATE subscribers SET expire_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(subscriberId);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    m.SubscriptionService.refreshSuspension(subscriberId);
    await m.ProvisionService.requestSync(serverId); // дожидается синхронизации, запущенной приостановкой
    expect(await awgShow()).not.toContain(peer.publicKey);
    for (const client of clients) expect(await awgShow()).toContain(client.publicKey);

    m.db.prepare('UPDATE subscribers SET expire_at = NULL WHERE id = ?').run(subscriberId);
    m.SubscriptionService.refreshSuspension(subscriberId);
    await m.ProvisionService.requestSync(serverId);
    expect(await awgShow()).toContain(peer.publicKey);
    vi.restoreAllMocks();
  }, 120000);

  it('опрос ноды читает интерфейс; неверный отпечаток SSH-хоста переводит сервер в error, сброс — возвращает online', async () => {
    await m.ProvisionService.fetchServerStats(serverId);
    expect(server()).toMatchObject({ status: 'online', fail_count: 0 });
    // Версии ПО с настоящего контейнера образа amneziavpn/amneziawg-go
    expect(server().node_awg_go).toMatch(/^\d+\.\d+\.\d+/);
    expect(server().node_awg_tools).toMatch(/^amneziawg-tools \d+\.\d+/);
    expect(server().node_image).toBe('amneziavpn/amneziawg-go:latest');
    expect(server().node_image_created).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    m.db.prepare("UPDATE servers SET host_key = 'SHA256:подделка' WHERE id = ?").run(serverId);
    await m.ProvisionService.fetchServerStats(serverId);
    expect(server().status).toBe('error');
    expect(server().last_error).toContain('Ключ SSH-хоста изменился');
    expect(server().fail_count).toBe(0);

    m.db.prepare('UPDATE servers SET host_key = NULL WHERE id = ?').run(serverId);
    await m.ProvisionService.fetchServerStats(serverId);
    expect(server()).toMatchObject({ status: 'online' });
    expect(server().host_key).toMatch(/^SHA256:/);
  }, 120000);

  it('повторное подключение найденного контейнера не дублирует клиентов и не меняет ключи', async () => {
    const before = m.db.prepare('SELECT COUNT(*) AS c FROM clients WHERE server_id = ?').get(serverId) as { c: number };
    const publicKey = server().server_public_key;

    const result = await m.ProvisionService.scanAndAdopt(serverId);

    expect(result.found).toBe(true);
    expect(result.adopted).toMatchObject({ managedBy: 'demension', awgVersion: 3, port: 51830, importedPeers: 0 });
    expect(m.db.prepare('SELECT COUNT(*) AS c FROM clients WHERE server_id = ?').get(serverId)).toEqual(before);
    expect(server().server_public_key).toBe(publicKey);
  }, 60000);

  it('удаление контейнера убирает его с узла и каталог конфигурации', async () => {
    const result = await m.ProvisionService.teardown(serverId);
    expect(result.success).toBe(true);
    expect(((await ssh('docker ps -a --format "{{.Names}}"')).stdout as string)).not.toContain('amnezia-awg');
    expect(((await ssh('ls /opt/amnezia 2>&1 || true')).stdout as string)).not.toContain('awg');
  }, 60000);
});
