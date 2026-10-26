import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Заглушка проверки доступности и мост на настоящих Docker-узлах: dementia-node-1 (SSH 2222) — нода с заглушкой,
 * dementia-node-2 (SSH 2223) — мост в «стране пользователя». Проверяется, что заглушка отвечает по TCP и UDP и пишет
 * журнал, а мост пересылает трафик на ноду (TCP-порт моста — на заглушку, как в сквозной проверке панели).
 * Без запущенных узлов (server/test/docker/nodes.sh up) тесты пропускаются.
 */

const NODE_SSH = 2222;
const BRIDGE_SSH = 2223;

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

const available = (await isPortOpen(NODE_SSH)) && (await isPortOpen(BRIDGE_SSH));

describe.skipIf(!available)('Заглушка и мост на реальных Docker-узлах', () => {
  let tmpDir: string;
  let m: { db: any; ProvisionService: any; BridgeService: any; SshService: any; parseHealth: any };
  let serverId: number;
  let bridgeId: number;
  let nodeIp: string;
  let bridgeIp: string;
  let stubPort: number;

  const creds = (port: number) => ({ host: '127.0.0.1', port, username: 'root', password: 'rootpass123' });
  const run = async (port: number, command: string) => {
    const result = await m.SshService.executeCommand(creds(port), command, { timeoutMs: 120000 });
    return result as { code: number; stdout: string; stderr: string };
  };
  const ipOf = async (port: number) => (await run(port, "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1")).stdout.trim();

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-docker-bridge-'));
    process.env.DEMENTIA_DATA_DIR = tmpDir;
    const dbModule = await import('../src/db/index.js');
    dbModule.initDatabase();
    const helpers = await import('./helpers/db.js');
    const bridgeModule = await import('../src/services/bridge.service.js');
    m = {
      db: dbModule.db,
      ProvisionService: (await import('../src/services/provision.service.js')).ProvisionService,
      BridgeService: bridgeModule.BridgeService,
      SshService: (await import('../src/services/ssh.service.js')).SshService,
      parseHealth: bridgeModule.parseHealth,
    };
    // Заглушке AmneziaWG не нужен: достаточно Docker на узле
    serverId = helpers.insertServer({ name: 'Docker stub node', host: '127.0.0.1', sshPassword: 'rootpass123', awgPort: 51820 });
    m.db.prepare('UPDATE servers SET ssh_port = ? WHERE id = ?').run(NODE_SSH, serverId);
    nodeIp = await ipOf(NODE_SSH);
    bridgeIp = await ipOf(BRIDGE_SSH);
    // Прежние запуски могли оставить мост и заглушку
    await run(BRIDGE_SSH, 'iptables -t nat -D PREROUTING -m addrtype --dst-type LOCAL -j DEMENTIA-BRIDGE 2>/dev/null; rm -rf /etc/dementia-bridge; true');
  }, 60000);

  afterAll(async () => {
    if (!m) return;
    await run(NODE_SSH, 'docker rm -f dementia-probe >/dev/null 2>&1; rm -rf /opt/dementia-probe; true');
    // На Windows открытый файл БД не даёт удалить каталог
    try {
      m.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // временный каталог удалит система
    }
  });

  it('заглушка ставится на свободный порт и отвечает по TCP страницей с меткой', async () => {
    stubPort = await m.ProvisionService.ensureProbeStub(serverId);
    expect(stubPort).toBeGreaterThanOrEqual(20000);
    const row = m.db.prepare('SELECT stub_port, stub_token FROM servers WHERE id = ?').get(serverId);
    expect(row.stub_port).toBe(stubPort);

    // запрос «проверяющего узла» — с другого узла сети
    const page = await run(BRIDGE_SSH, `curl -s --max-time 10 http://${nodeIp}:${stubPort}/nonce0123456789ab`);
    expect(page.stdout).toContain('Coming soon');
    expect(page.stdout).toContain(row.stub_token);
    // контейнер AmneziaWG заглушка не создаёт и не трогает
    expect((await run(NODE_SSH, "docker ps -a --format '{{.Names}}'")).stdout).not.toContain('amnezia-awg');
  }, 300000);

  it('UDP-пакет получает ответ; журнал содержит обращения с адресом отправителя и меткой', async () => {
    const udp = await run(BRIDGE_SSH, `printf 'probe' | nc -u -w 3 ${nodeIp} ${stubPort}`);
    expect(udp.stdout).toContain('ok');

    const hits = await m.ProvisionService.readProbeHits(serverId);
    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proto: 'tcp', ip: bridgeIp, path: '/nonce0123456789ab' }),
        expect.objectContaining({ proto: 'udp', ip: bridgeIp }),
      ])
    );
  }, 60000);

  it('повторная установка сохраняет порт, если он свободен', async () => {
    expect(await m.ProvisionService.ensureProbeStub(serverId)).toBe(stubPort);
  }, 300000);

  it('мост: установка без Docker и systemd, пересылка TCP на заглушку ноды, правила на месте', async () => {
    // Адрес ноды для моста — её адрес в сети узлов (SSH к ней дальше не нужен)
    m.db.prepare('UPDATE servers SET host = ? WHERE id = ?').run(nodeIp, serverId);
    bridgeId = m.BridgeService.create({ name: 'Docker bridge', host: '127.0.0.1', ssh_port: BRIDGE_SSH, ssh_password: 'rootpass123', country: 'ru' });
    const linked = await m.BridgeService.setLinks(bridgeId, [{ server_id: serverId, mode: 'auto' }]);
    expect(linked.success).toBe(true);
    const install = await m.BridgeService.install(bridgeId);
    expect(install.error ?? null).toBeNull();
    expect(install.success).toBe(true);

    // Клиент обращается к мосту на его порт — отвечает заглушка ноды
    const listen = m.BridgeService.get(bridgeId).links[0].listen_port;
    expect(listen).toBe(51820);
    const token = m.db.prepare('SELECT stub_token FROM servers WHERE id = ?').get(serverId).stub_token;
    const viaBridge = await run(NODE_SSH, `curl -s --max-time 10 http://${bridgeIp}:${listen}/viabridge`);
    expect(viaBridge.stdout).toContain(token);

    const health = await run(
      BRIDGE_SSH,
      "echo \"RULES $(iptables -t nat -S DEMENTIA-BRIDGE | grep -c '^-A DEMENTIA-BRIDGE ')\"; echo \"FIRST $(iptables -S FORWARD | sed -n 2p)\"; echo \"PRE $(iptables -t nat -S PREROUTING | grep -c 'DEMENTIA-BRIDGE$')\""
    );
    expect(m.parseHealth(health.stdout)).toEqual({ rules: 2, forwardFirst: true, prerouting: true });
    expect((await run(BRIDGE_SSH, 'cat /etc/dementia-bridge/rules.sh')).stdout).toContain(`forward udp 51820 '${nodeIp}' 51820`);
  }, 300000);

  it('повторное применение не дублирует переходы; снятие привязки убирает правила', async () => {
    expect((await m.BridgeService.requestApply(bridgeId)).success).toBe(true);
    expect((await m.BridgeService.requestApply(bridgeId)).success).toBe(true);
    const jumps = await run(BRIDGE_SSH, "iptables -S FORWARD | grep -c DEMENTIA-BRIDGE-FWD; iptables -t nat -S PREROUTING | grep -c 'DEMENTIA-BRIDGE$'");
    expect(jumps.stdout.trim().split(/\s+/)).toEqual(['1', '1']);

    expect((await m.BridgeService.setLinks(bridgeId, [])).success).toBe(true);
    expect((await run(BRIDGE_SSH, "iptables -t nat -S DEMENTIA-BRIDGE | grep -c '^-A' || true")).stdout.trim()).toBe('0');
  }, 120000);

  it('удаление моста с очисткой убирает цепочки панели', async () => {
    expect((await m.BridgeService.teardown(bridgeId)).success).toBe(true);
    const left = await run(BRIDGE_SSH, 'iptables-save | grep -c DEMENTIA || true; ls /etc/dementia-bridge 2>&1 || true');
    expect(left.stdout).toMatch(/^0\n/);
    expect(left.stdout).toContain('No such file');
  }, 60000);
});
