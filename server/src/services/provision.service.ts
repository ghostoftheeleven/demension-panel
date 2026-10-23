import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import { SshService } from './ssh.service.js';
import { AwgService } from './awg.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ProvisionService {
  /**
   * Run remote AmneziaWG installation via Docker and configure firewall & interface
   */
  static async installServer(
    serverId: number,
    onLog?: (chunk: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) {
      throw new Error(`Сервер #${serverId} не найден`);
    }

    db.prepare("UPDATE servers SET status = 'installing' WHERE id = ?").run(serverId);
    if (onLog) onLog(`=== Запуск установки AmneziaWG на ${server.name} (${server.host}) ===\r\n`);

    try {
      // Generate keys and AWG params if not already set
      let privKey = server.server_private_key;
      let pubKey = server.server_public_key;
      let psk = server.preshared_key;

      if (!privKey || !pubKey) {
        const keyPair = AwgService.generateKeyPair();
        privKey = keyPair.privateKey;
        pubKey = keyPair.publicKey;
      }

      if (!psk) {
        psk = AwgService.generatePresharedKey();
      }

      // Read deploy script
      const scriptCandidates = [
        path.resolve(process.cwd(), 'src/scripts/deploy-awg.sh'),
        path.resolve(process.cwd(), 'dist/scripts/deploy-awg.sh'),
        path.resolve(__dirname, '../scripts/deploy-awg.sh'),
      ];
      let scriptContent = '';
      for (const candidate of scriptCandidates) {
        if (fs.existsSync(candidate)) {
          scriptContent = fs.readFileSync(candidate, 'utf-8');
          break;
        }
      }
      if (!scriptContent) {
        throw new Error('Установочный скрипт deploy-awg.sh не найден');
      }

      // Prepare env vars prefix
      const envExports = `
export AWG_PORT=${server.awg_port || 51820}
export AWG_SUBNET="${server.subnet || '10.8.0.1/24'}"
export AWG_JC=${server.jc || 4}
export AWG_JMIN=${server.jmin || 40}
export AWG_JMAX=${server.jmax || 70}
export AWG_S1=${server.s1 || 36}
export AWG_S2=${server.s2 || 124}
export AWG_H1=${server.h1 || 124357689}
export AWG_H2=${server.h2 || 987654321}
export AWG_H3=${server.h3 || 135792468}
export AWG_H4=${server.h4 || 246813579}
export AWG_SERVER_PRIV_KEY="${privKey}"
export AWG_PSK="${psk}"
`;

      const remoteTmpScript = '/tmp/deploy-awg.sh';
      const fullScript = envExports + '\n' + scriptContent;

      const credentials = {
        host: server.host,
        port: server.ssh_port,
        username: server.ssh_user,
        password: server.ssh_password,
        privateKey: server.ssh_key,
      };

      if (onLog) onLog('Загрузка установочного скрипта на удаленный сервер...\r\n');
      await SshService.uploadContent(credentials, remoteTmpScript, fullScript);

      if (onLog) onLog('Запуск скрипта развертывания...\r\n');
      const result = await SshService.executeCommand(
        credentials,
        `chmod +x ${remoteTmpScript} && sudo bash ${remoteTmpScript} && rm -f ${remoteTmpScript}`,
        (chunk) => {
          if (onLog) onLog(chunk);
        }
      );

      if (result.code !== 0) {
        throw new Error(`Скрипт завершился с кодом ошибки ${result.code}: ${result.stderr}`);
      }

      // Parse JSON output from script
      const match = result.stdout.match(/---DEMENSION_RESULT_START---([\s\S]*?)---DEMENSION_RESULT_END---/);
      if (match) {
        const parsed = JSON.parse(match[1].trim());
        db.prepare(`
          UPDATE servers 
          SET status = 'online',
              server_public_key = ?,
              server_private_key = ?,
              preshared_key = ?,
              last_seen = datetime('now')
          WHERE id = ?
        `).run(parsed.serverPublicKey, privKey, parsed.presharedKey, serverId);
      } else {
        db.prepare("UPDATE servers SET status = 'online', last_seen = datetime('now') WHERE id = ?").run(serverId);
      }

      if (onLog) onLog('\r\n=== AmneziaWG успешно установлен и готов к работе! ===\r\n');
      return { success: true };
    } catch (err: any) {
      db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(serverId);
      if (onLog) onLog(`\r\n❌ Ошибка: ${err.message}\r\n`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Hot-sync all active peers to server awg0.conf without dropping existing connections
   */
  static async syncPeers(serverId: number): Promise<{ success: boolean; error?: string }> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) throw new Error(`Сервер #${serverId} не найден`);

    const clients = db.prepare('SELECT * FROM clients WHERE server_id = ?').all(serverId) as any[];

    // Generate new full awg0.conf
    const newConf = AwgService.generateServerConfig(server, clients);

    const credentials = {
      host: server.host,
      port: server.ssh_port,
      username: server.ssh_user,
      password: server.ssh_password,
      privateKey: server.ssh_key,
    };

    const tmpPath = '/tmp/awg0.conf';
    await SshService.uploadContent(credentials, tmpPath, newConf);

    // Move to /opt/amnezia/awg/awg0.conf and syncconf inside Docker
    const command = `
      sudo mv ${tmpPath} /opt/amnezia/awg/awg0.conf && \
      sudo chmod 600 /opt/amnezia/awg/awg0.conf && \
      sudo docker exec amnezia-awg bash -c "awg syncconf awg0 <(awg-quick strip /opt/amnezia/awg/awg0.conf)"
    `;

    const result = await SshService.executeCommand(credentials, command);
    if (result.code !== 0) {
      throw new Error(`Ошибка синхронизации конфигурации: ${result.stderr}`);
    }

    return { success: true };
  }

  /**
   * Poll live interface stats (rx/tx, handshake) and update DB
   */
  static async fetchServerStats(serverId: number): Promise<void> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server || server.status === 'uninstalled') return;

    const credentials = {
      host: server.host,
      port: server.ssh_port,
      username: server.ssh_user,
      password: server.ssh_password,
      privateKey: server.ssh_key,
    };

    try {
      const result = await SshService.executeCommand(
        credentials,
        'sudo docker exec amnezia-awg awg show awg0 dump 2>/dev/null'
      );

      if (result.code === 0 && result.stdout) {
        db.prepare("UPDATE servers SET status = 'online', last_seen = datetime('now') WHERE id = ?").run(serverId);

        const lines = result.stdout.trim().split('\n');
        // Line 0 is interface info: privateKey publicKey listenPort fwmark
        // Lines 1..N are peers:
        // peerPublicKey psk endpoint allowedIPs latestHandshake rxBytes txBytes persistentKeepalive
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split('\t');
          if (parts.length >= 7) {
            const pubKey = parts[0];
            const latestHandshakeEpoch = parseInt(parts[4], 10);
            const rxBytes = parseInt(parts[5], 10) || 0;
            const txBytes = parseInt(parts[6], 10) || 0;

            const handshakeDate =
              latestHandshakeEpoch > 0
                ? new Date(latestHandshakeEpoch * 1000).toISOString()
                : null;

            db.prepare(`
              UPDATE clients 
              SET total_rx = ?, total_tx = ?, last_handshake = ? 
              WHERE server_id = ? AND client_public_key = ?
            `).run(rxBytes, txBytes, handshakeDate, serverId, pubKey);
          }
        }
      }
    } catch {
      db.prepare("UPDATE servers SET status = 'offline' WHERE id = ?").run(serverId);
    }
  }
}
