import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      s.destroy();
      resolve(false);
    });
    s.setTimeout(800, () => {
      s.destroy();
      resolve(false);
    });
  });
}

const isDockerRunning = await isPortOpen(2222);

describe.skipIf(!isDockerRunning)('Real Docker VPS Node E2E Integration Suite', () => {
  let tmpDir: string;
  let db: any;
  let initDatabase: any;
  let encryptSecret: any;
  let ProvisionService: any;
  let AwgService: any;
  let paramsToColumns: any;
  let SshService: any;
  let serverId: number;
  let clientId: number;
  let clientKp: any;

  beforeAll(async () => {
    tmpDir = path.join(os.tmpdir(), `dementia-docker-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.DEMENTIA_DATA_DIR = tmpDir;

    const dbModule = await import('../src/db/index.js');
    db = dbModule.db;
    initDatabase = dbModule.initDatabase;
    initDatabase();

    const secretsModule = await import('../src/services/secrets.service.js');
    encryptSecret = secretsModule.encryptSecret;

    const provModule = await import('../src/services/provision.service.js');
    ProvisionService = provModule.ProvisionService;

    const awgModule = await import('../src/services/awg.service.js');
    AwgService = awgModule.AwgService;

    const paramsModule = await import('../src/utils/awg-params.js');
    paramsToColumns = paramsModule.paramsToColumns;

    const sshModule = await import('../src/services/ssh.service.js');
    SshService = sshModule.SshService;
  });

  afterAll(async () => {
    if (serverId && ProvisionService) {
      try {
        await ProvisionService.teardown(serverId);
      } catch {}
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('connects to mock VPS container via SSH', async () => {
    const res = await SshService.testConnection({
      host: '127.0.0.1',
      port: 2222,
      username: 'root',
      password: 'rootpass123',
    });
    expect(res.success).toBe(true);
  });

  it('installs AmneziaWG via Docker DinD on the remote node', async () => {
    const randomParams = AwgService.generateRandomParams();
    const paramCols = paramsToColumns(randomParams);

    const serverRes = db.prepare(`
      INSERT INTO servers (
        name, host, ssh_port, ssh_user, ssh_password,
        awg_port, subnet, status,
        ${Object.keys(paramCols).join(', ')}
      ) VALUES (
        'Node 1 (Docker)', '127.0.0.1', 2222, 'root', ?,
        51820, '10.8.0.0/24', 'offline',
        ${Object.keys(paramCols).map(() => '?').join(', ')}
      )
    `).run(encryptSecret('rootpass123'), ...(Object.values(paramCols) as any[]));

    serverId = Number(serverRes.lastInsertRowid);
    expect(serverId).toBeGreaterThan(0);

    const installRes = await ProvisionService.installServer(serverId);
    expect(installRes.success).toBe(true);

    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    expect(row.status).toBe('online');
    expect(row.iface).toBe('awg0');
    expect(row.container_name).toBe('amnezia-awg');
  }, 120000);

  it('detects running AmneziaWG container via detectContainers', async () => {
    const serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    const containers = await ProvisionService.detectContainers(serverRow);
    expect(containers.length).toBeGreaterThanOrEqual(1);

    const awg = containers.find((c: any) => c.name === 'amnezia-awg');
    expect(awg).toBeDefined();
    expect(awg.running).toBe(true);
    expect(awg.managedBy).toBe('demension');
  }, 30000);

  it('adds client, synchronizes peers, and verifies peer in running awg0 interface', async () => {
    clientKp = AwgService.generateKeyPair();
    const res = db.prepare(`
      INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key, enabled)
      VALUES (?, 'Docker Test Client', '10.8.0.2', ?, ?, 1)
    `).run(serverId, clientKp.publicKey, clientKp.privateKey);

    clientId = Number(res.lastInsertRowid);
    expect(clientId).toBeGreaterThan(0);

    const syncRes = await ProvisionService.syncPeers(serverId);
    expect(syncRes.success).toBe(true);

    const serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    const creds = ProvisionService.getCredentials(serverRow);
    const showRes = await SshService.executeCommand(creds, 'docker exec amnezia-awg awg show awg0');

    expect(showRes.stdout).toContain(clientKp.publicKey);
    expect(showRes.stdout).toContain('10.8.0.2/32');
  }, 30000);

  it('polls live stats via fetchServerStats and processes interface dump', async () => {
    await ProvisionService.fetchServerStats(serverId);
    const serverRow = db.prepare('SELECT status, last_seen FROM servers WHERE id = ?').get(serverId) as any;
    expect(serverRow.status).toBe('online');
    expect(serverRow.last_seen).toBeTruthy();
  }, 30000);

  it('applies updated obfuscation params and restarts container via requestApply', async () => {
    db.prepare('UPDATE servers SET s1 = 68, needs_apply = 1 WHERE id = ?').run(serverId);
    const applyRes = await ProvisionService.requestApply(serverId);
    expect(applyRes.success).toBe(true);

    const serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    const creds = ProvisionService.getCredentials(serverRow);
    const confCheck = await SshService.executeCommand(creds, 'docker exec amnezia-awg cat /opt/amnezia/awg/awg0.conf');
    expect(confCheck.stdout).toContain('S1 = 68');
  }, 60000);

  it('scans and adopts running container without reinstalling via scanAndAdopt', async () => {
    const adoptRes = await ProvisionService.scanAndAdopt(serverId);
    expect(adoptRes.found).toBe(true);
    expect(adoptRes.adopted?.container).toBe('amnezia-awg');
    expect(adoptRes.adopted?.awgVersion).toBe(3);
  }, 30000);

  it('removes peer from interface when client is disabled', async () => {
    db.prepare('UPDATE clients SET enabled = 0 WHERE id = ?').run(clientId);
    await ProvisionService.syncPeers(serverId);

    const serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    const creds = ProvisionService.getCredentials(serverRow);
    const showRes = await SshService.executeCommand(creds, 'docker exec amnezia-awg awg show awg0');

    expect(showRes.stdout).not.toContain(clientKp.publicKey);
  }, 30000);

  it('teardown stops and removes container and cleanup directories', async () => {
    const teardownRes = await ProvisionService.teardown(serverId);
    expect(teardownRes.success).toBe(true);

    const serverRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    const creds = ProvisionService.getCredentials(serverRow);
    const checkRes = await SshService.executeCommand(creds, 'docker ps -a --format "{{.Names}}"');
    expect(checkRes.stdout).not.toContain('amnezia-awg');
  }, 60000);
});
