import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Сервер, где AmneziaWG уже стоит от приложения AmneziaVPN, а панель подключается к нему (на второй тестовой ноде).
 * Контейнер повторяет устройство контейнера приложения: имя amnezia-awg, конфиг wg0.conf и clientsTable внутри контейнера
 * (без томов), start.sh поднимает интерфейс при каждом запуске контейнера. Без запущенной ноды (SSH 2223) тесты пропускаются.
 */

const NODE = 'demension-node-2';
const SSH_PORT = 2223;
const AWG_PORT = 55424;

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

/** Команда Docker внутри тестовой ноды */
const nodeDocker = (args: string[], input?: string): string =>
  execFileSync('docker', ['exec', '-i', NODE, 'docker', ...args], { input, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
const tryNodeDocker = (args: string[]): string => {
  try {
    return nodeDocker(args);
  } catch {
    return '';
  }
};
/** Команда внутри контейнера Amnezia */
const inAmnezia = (script: string, input?: string): string => nodeDocker(['exec', '-i', 'amnezia-awg', 'sh', '-c', script], input);
const awgShow = (): string => tryNodeDocker(['exec', 'amnezia-awg', 'awg', 'show', 'wg0']);
const containerExists = (name: string): boolean => tryNodeDocker(['ps', '-a', '--format', '{{.Names}}']).split('\n').includes(name);

const FAKE_AMNEZIA_DOCKERFILE = `FROM amneziavpn/amneziawg-go:latest
RUN mkdir -p /opt/amnezia/awg \\
 && printf '%s\\n' '#!/bin/bash' 'echo "Container startup"' \\
    'awg-quick down /opt/amnezia/awg/wg0.conf 2>/dev/null' \\
    'if [ -f /opt/amnezia/awg/wg0.conf ]; then (awg-quick up /opt/amnezia/awg/wg0.conf); fi' \\
    'iptables -A INPUT -i wg0 -j ACCEPT' 'iptables -A FORWARD -i wg0 -j ACCEPT' 'iptables -A OUTPUT -o wg0 -j ACCEPT' \\
    'iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT' \\
    'iptables -t nat -A POSTROUTING -s 10.8.1.0/24 -o eth0 -j MASQUERADE' 'tail -f /dev/null' > /opt/amnezia/start.sh \\
 && chmod +x /opt/amnezia/start.sh
ENTRYPOINT ["/opt/amnezia/start.sh"]
`;

describe.skipIf(!dockerNodeAvailable)('Сервер с уже установленным AmneziaWG от приложения AmneziaVPN', () => {
  let tmpDir: string;
  let m: any;
  let serverId: number;
  let serverPublicKey: string;
  const appPeers = [
    { name: 'Телефон Алисы', ip: '10.8.1.2', publicKey: '', suffix: '/32' },
    { name: 'Ноутбук Боба', ip: '10.8.1.3', publicKey: '', suffix: '' }, // AllowedIPs без маски
  ];

  const server = () => m.db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  const ssh = (command: string) => m.SshService.executeCommand(m.ProvisionService.getCredentials(server()), command, { timeoutMs: 60000 });
  const containerStart = () => tryNodeDocker(['inspect', '-f', '{{.State.StartedAt}}', 'amnezia-awg']).trim();

  async function startAmneziaContainer() {
    tryNodeDocker(['rm', '-f', 'amnezia-awg']);
    // Остаток прежней установки панели на хосте (файл demension.env без контейнера): он не должен выдавать чужой контейнер за свой
    execFileSync('docker', ['exec', NODE, 'sh', '-c', 'rm -rf /opt/amnezia && mkdir -p /opt/amnezia/awg && echo stale > /opt/amnezia/awg/demension.env']);
    nodeDocker(['build', '-q', '-t', 'fake-amnezia-awg', '-'], FAKE_AMNEZIA_DOCKERFILE);
    nodeDocker([
      'run', '-d', '--name', 'amnezia-awg', '--cap-add=NET_ADMIN', '--cap-add=SYS_MODULE', '--device', '/dev/net/tun:/dev/net/tun',
      '-p', `${AWG_PORT}:${AWG_PORT}/udp`, '--sysctl', 'net.ipv4.ip_forward=1', 'fake-amnezia-awg',
    ]);

    const serverKeys = m.AwgService.generateKeyPair();
    serverPublicKey = serverKeys.publicKey;
    for (const peer of appPeers) peer.publicKey = m.AwgService.generateKeyPair().publicKey;
    const psk = m.AwgService.generatePresharedKey();
    const conf = [
      '[Interface]', `PrivateKey = ${serverKeys.privateKey}`, 'Address = 10.8.1.0/24', `ListenPort = ${AWG_PORT}`,
      'Jc = 5', 'Jmin = 10', 'Jmax = 50', 'S1 = 30', 'S2 = 40', 'H1 = 1111111111', 'H2 = 2222222222', 'H3 = 1333333333', 'H4 = 1444444444',
      ...appPeers.flatMap((p) => ['', '[Peer]', `PublicKey = ${p.publicKey}`, `PresharedKey = ${psk}`, `AllowedIPs = ${p.ip}${p.suffix}`]),
      '',
    ].join('\n');
    const table = JSON.stringify(appPeers.map((p) => ({ clientId: p.publicKey, userData: { clientName: p.name, creationDate: 'Mon Jan 1 2026' } })));
    inAmnezia('cat > /opt/amnezia/awg/wg0.conf', conf);
    inAmnezia('cat > /opt/amnezia/awg/clientsTable', table);
    inAmnezia('awg-quick up /opt/amnezia/awg/wg0.conf');
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demension-docker-amnezia-'));
    process.env.DEMENSION_DATA_DIR = tmpDir;
    const dbModule = await import('../src/db/index.js');
    dbModule.initDatabase();
    const helpers = await import('./helpers/db.js');
    m = {
      db: dbModule.db,
      ProvisionService: (await import('../src/services/provision.service.js')).ProvisionService,
      SshService: (await import('../src/services/ssh.service.js')).SshService,
      AwgService: (await import('../src/services/awg.service.js')).AwgService,
      insertClient: helpers.insertClient,
    };
    await startAmneziaContainer();
    // Сервер добавлен в панель, но ещё не сканировался и не устанавливался (как сразу после «Добавить сервер»)
    serverId = helpers.insertServer({ name: 'Сервер с Amnezia', host: '127.0.0.1', status: 'uninstalled', deployedPort: null, sshPassword: 'rootpass123', awgVersion: 1 });
    m.db.prepare('UPDATE servers SET ssh_port = ? WHERE id = ?').run(SSH_PORT, serverId);
  }, 300000);

  afterAll(async () => {
    tryNodeDocker(['rm', '-f', 'amnezia-awg']);
    tryNodeDocker(['rmi', '-f', 'fake-amnezia-awg']);
    try {
      execFileSync('docker', ['exec', NODE, 'rm', '-rf', '/opt/amnezia']);
    } catch {
      // нода могла быть остановлена
    }
    try {
      m?.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // временный каталог удалит система
    }
  });

  it('установка панели поверх чужого контейнера отказывается и ничего не удаляет', async () => {
    const before = containerStart();

    const result = await m.ProvisionService.installServer(serverId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('приложения Amnezia');
    expect(result.error).toContain('Сканировать');
    expect(containerExists('amnezia-awg')).toBe(true);
    expect(containerStart()).toBe(before);
    for (const peer of appPeers) expect(awgShow()).toContain(peer.publicKey);
    expect(server().status).toBe('uninstalled');
  }, 120000);

  it('сканирование подключает контейнер без изменений: ключи, порт, параметры и клиенты приложения переносятся', async () => {
    const before = containerStart();

    const result = await m.ProvisionService.scanAndAdopt(serverId);

    expect(result.found).toBe(true);
    expect(result.adopted).toMatchObject({ container: 'amnezia-awg', managedBy: 'amnezia', awgVersion: 1, port: AWG_PORT, importedPeers: 2, skippedPeers: 0 });
    expect(server()).toMatchObject({
      status: 'online', awg_port: AWG_PORT, deployed_port: AWG_PORT, subnet: '10.8.1.0/24', container_name: 'amnezia-awg', iface: 'wg0',
      managed_by: 'amnezia', server_public_key: serverPublicKey, jc: 5, s1: 30,
    });
    const imported = m.db.prepare('SELECT name, client_ip, external FROM clients WHERE server_id = ? ORDER BY client_ip').all(serverId);
    expect(imported).toEqual([
      { name: 'Телефон Алисы', client_ip: '10.8.1.2', external: 1 },
      { name: 'Ноутбук Боба', client_ip: '10.8.1.3', external: 1 },
    ]);
    // Контейнер не перезапускался, интерфейс и клиенты на месте
    expect(containerStart()).toBe(before);
    for (const peer of appPeers) expect(awgShow()).toContain(peer.publicKey);
  }, 60000);

  it('синхронизация добавляет клиента панели и сохраняет клиентов приложения; конфигурация остаётся в контейнере', async () => {
    const own = m.insertClient(serverId, { ip: '10.8.1.10', name: 'Из панели' });
    const result = await m.ProvisionService.requestSync(serverId);

    expect(result.success).toBe(true);
    const shown = awgShow();
    expect(shown).toContain(own.publicKey);
    for (const peer of appPeers) expect(shown).toContain(peer.publicKey);
    expect(inAmnezia('cat /opt/amnezia/awg/wg0.conf')).toContain(own.publicKey);
    // Пароли в записи клиентов приложения не потеряны
    expect(inAmnezia('cat /opt/amnezia/awg/wg0.conf').match(/PresharedKey/g)).toHaveLength(3);
  }, 60000);

  it('отключение клиента приложения в панели убирает его из интерфейса, остальные продолжают работать', async () => {
    m.db.prepare("UPDATE clients SET enabled = 0 WHERE name = 'Ноутбук Боба'").run();
    expect((await m.ProvisionService.requestSync(serverId)).success).toBe(true);
    expect(awgShow()).not.toContain(appPeers[1].publicKey);
    expect(awgShow()).toContain(appPeers[0].publicKey);

    m.db.prepare("UPDATE clients SET enabled = 1 WHERE name = 'Ноутбук Боба'").run();
    await m.ProvisionService.requestSync(serverId);
    expect(awgShow()).toContain(appPeers[1].publicKey);
  }, 60000);

  it('смена параметров перезапускает контейнер, start.sh поднимает интерфейс из обновлённого конфига', async () => {
    const before = containerStart();
    m.db.prepare('UPDATE servers SET jc = 7 WHERE id = ?').run(serverId);

    const result = await m.ProvisionService.requestApply(serverId);

    expect(result.success).toBe(true);
    expect(containerStart()).not.toBe(before);
    expect(inAmnezia('cat /opt/amnezia/awg/wg0.conf')).toContain('Jc = 7');
    const shown = awgShow();
    expect(shown).toContain('jc: 7');
    for (const peer of appPeers) expect(shown).toContain(peer.publicKey);
  }, 120000);

  it('«Переустановить» после подключения заменяет контейнер приложения контейнером панели с теми же ключами и клиентами', async () => {
    const own = m.db.prepare("SELECT client_public_key FROM clients WHERE name = 'Из панели'").get() as any;

    const result = await m.ProvisionService.requestReinstall(serverId);

    expect(result.success).toBe(true);
    expect(server()).toMatchObject({ managed_by: 'demension', iface: 'awg0', container_name: 'amnezia-awg', server_public_key: serverPublicKey });
    const shown = tryNodeDocker(['exec', 'amnezia-awg', 'awg', 'show', 'awg0']);
    expect(shown).toContain(serverPublicKey);
    expect(shown).toContain(own.client_public_key);
    for (const peer of appPeers) expect(shown).toContain(peer.publicKey);
    expect(shown).toContain(`listening port: ${AWG_PORT}`);
  }, 180000);

  it('после этого контейнер считается контейнером панели: повторная установка разрешена', async () => {
    const result = await m.ProvisionService.requestReinstall(serverId);
    expect(result.success).toBe(true);
    expect(tryNodeDocker(['exec', 'amnezia-awg', 'awg', 'show', 'awg0'])).toContain(appPeers[0].publicKey);
    expect((await m.ProvisionService.teardown(serverId)).success).toBe(true);
    expect(containerExists('amnezia-awg')).toBe(false);
  }, 180000);
});
