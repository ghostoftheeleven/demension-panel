import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';
import { SshService, SshCredentials, HostKeyMismatchError } from './ssh.service.js';
import { AwgService } from './awg.service.js';
import { decryptSecret } from './secrets.service.js';
import { shellQuote } from '../utils/net.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTAINER = 'amnezia-awg';
/** На ноды всегда ставится актуальный образ AmneziaWG (docker pull при каждой установке/переустановке) */
export const AWG_IMAGE = 'amneziavpn/amneziawg-go:latest';
const AWG_DIR = '/opt/amnezia/awg';
/** Сколько неудачных опросов подряд переводят сервер в offline */
const OFFLINE_THRESHOLD = 3;

export interface OperationResult {
  success: boolean;
  error?: string;
}

// Все операции с одной нодой выполняются последовательно
const chains = new Map<number, Promise<unknown>>();
// Запрошенная, но ещё не начатая синхронизация (повторные запросы объединяются)
const pendingSync = new Map<number, Promise<OperationResult>>();
const installing = new Set<number>();

function runExclusive<T>(serverId: number, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(serverId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  chains.set(serverId, tail);
  tail.then(() => {
    if (chains.get(serverId) === tail) chains.delete(serverId);
  });
  return next;
}

function loadServer(serverId: number): any {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  if (!server) throw new Error(`Сервер #${serverId} не найден`);
  return server;
}

function readDeployScript(): string {
  const candidates = [
    path.resolve(__dirname, '../scripts/deploy-awg.sh'),
    path.resolve(process.cwd(), 'src/scripts/deploy-awg.sh'),
    path.resolve(process.cwd(), 'dist/scripts/deploy-awg.sh'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8');
  }
  throw new Error('Установочный скрипт deploy-awg.sh не найден');
}

export class ProvisionService {
  static getCredentials(server: any): SshCredentials {
    return {
      host: server.host,
      port: server.ssh_port,
      username: server.ssh_user,
      password: decryptSecret(server.ssh_password),
      privateKey: decryptSecret(server.ssh_key),
      hostKey: server.host_key,
      onNewHostKey: (fingerprint) => {
        db.prepare('UPDATE servers SET host_key = ? WHERE id = ? AND host_key IS NULL').run(fingerprint, server.id);
      },
    };
  }

  /**
   * Клиенты сервера с признаком активности подписчика (выключен/истёк/превышен лимит → 0)
   */
  static getServerClients(serverId: number): any[] {
    return db.prepare(`
      SELECT c.*,
        CASE
          WHEN c.subscriber_id IS NULL THEN 1
          WHEN sub.enabled = 1 AND sub.suspended = 0 THEN 1
          ELSE 0
        END AS subscriber_active
      FROM clients c
      LEFT JOIN subscribers sub ON sub.id = c.subscriber_id
      WHERE c.server_id = ?
    `).all(serverId) as any[];
  }

  static isInstalling(serverId: number): boolean {
    return installing.has(serverId);
  }

  /**
   * Команда, атомарно записывающая содержимое stdin в файл на ноде с правами 600
   */
  private static writeFileCommand(credentials: SshCredentials, remotePath: string): string {
    const tmp = `${remotePath}.new`;
    return `${SshService.sudo(credentials)}sh -c ${shellQuote(`umask 077 && mkdir -p ${AWG_DIR} && cat > ${tmp} && mv -f ${tmp} ${remotePath}`)}`;
  }

  private static envFileContent(server: any): string {
    return `AWG_NETWORK=${AwgService.getTunnelNetwork(server.subnet)}\nAWG_PORT=${server.awg_port}\n`;
  }

  /**
   * Run remote AmneziaWG installation via Docker and configure firewall & interface
   */
  static async installServer(serverId: number, onLog?: (chunk: string) => void): Promise<OperationResult> {
    const server = loadServer(serverId);
    if (installing.has(serverId)) {
      throw new Error('Установка этого сервера уже выполняется');
    }
    installing.add(serverId);
    pendingSync.delete(serverId);

    try {
      return await runExclusive(serverId, () => this.doInstall(server.id, onLog));
    } finally {
      installing.delete(serverId);
    }
  }

  private static async doInstall(serverId: number, onLog?: (chunk: string) => void): Promise<OperationResult> {
    const server = loadServer(serverId);
    const log = (text: string) => onLog?.(text);

    db.prepare("UPDATE servers SET status = 'installing', last_error = NULL WHERE id = ?").run(serverId);
    log(`=== Запуск установки AmneziaWG на ${server.name} (${server.host}) ===\r\n`);

    try {
      let privKey = server.server_private_key;
      let psk = server.preshared_key;
      if (!privKey) {
        privKey = AwgService.generateKeyPair().privateKey;
      }
      if (!psk) {
        psk = AwgService.generatePresharedKey();
      }
      const pubKey = AwgService.derivePublicKey(privKey);
      const fullServer = { ...server, server_private_key: privKey, server_public_key: pubKey, preshared_key: psk };

      const conf = AwgService.generateServerConfig(fullServer, this.getServerClients(serverId));
      const script = [
        `export AWG_PORT=${shellQuote(server.awg_port)}`,
        `export AWG_NETWORK=${shellQuote(AwgService.getTunnelNetwork(server.subnet))}`,
        `export AWG_CONF_B64=${shellQuote(Buffer.from(conf).toString('base64'))}`,
        `export AWG_IMAGE=${shellQuote(AWG_IMAGE)}`,
        readDeployScript(),
      ].join('\n');

      const credentials = this.getCredentials(server);
      log('Подключение по SSH и запуск скрипта развертывания...\r\n');

      // Скрипт передаётся через stdin и не сохраняется на диске ноды.
      // PANEL_IP (адрес, с которого подключилась панель) добавляется в ignoreip fail2ban,
      // чтобы панель не заблокировала сама себя.
      const result = await SshService.executeCommand(
        credentials,
        `${SshService.sudo(credentials)}env PANEL_IP="\${SSH_CLIENT%% *}" bash -c 'script=$(cat); exec bash -c "$script" deploy-awg'`,
        { input: script, onData: log, timeoutMs: 20 * 60 * 1000 }
      );

      if (result.code !== 0) {
        const hint = /sudo: a (terminal|password) is required/.test(result.stderr)
          ? ' Пользователю нужен sudo без пароля (NOPASSWD) или используйте root.'
          : '';
        throw new Error(`Скрипт завершился с кодом ошибки ${result.code}.${hint}`);
      }
      if (!result.stdout.includes('---DEMENSION_OK---')) {
        throw new Error('Скрипт не подтвердил успешный запуск AmneziaWG');
      }

      db.prepare(`
        UPDATE servers
        SET status = 'online',
            server_public_key = ?,
            server_private_key = ?,
            preshared_key = ?,
            deployed_port = awg_port,
            needs_sync = 0,
            needs_apply = 0,
            fail_count = 0,
            last_error = NULL,
            last_seen = datetime('now')
        WHERE id = ?
      `).run(pubKey, privKey, psk, serverId);

      log('\r\n=== AmneziaWG успешно установлен и готов к работе! ===\r\n');
      return { success: true };
    } catch (err: any) {
      db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
      log(`\r\n❌ Ошибка: ${err.message}\r\n`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Запросить синхронизацию пиров. Повторные запросы до начала выполнения объединяются.
   * При недоступности ноды флаг needs_sync остаётся, и фоновая задача повторит попытку.
   */
  static requestSync(serverId: number): Promise<OperationResult> {
    db.prepare('UPDATE servers SET needs_sync = 1 WHERE id = ?').run(serverId);
    const existing = pendingSync.get(serverId);
    if (existing) return existing;

    const promise = runExclusive(serverId, async () => {
      pendingSync.delete(serverId);
      return this.doSync(serverId);
    });
    pendingSync.set(serverId, promise);
    return promise;
  }

  /**
   * Синхронно дождаться синхронизации (для ручной кнопки в UI)
   */
  static async syncPeers(serverId: number): Promise<OperationResult> {
    return this.requestSync(serverId);
  }

  private static async doSync(serverId: number): Promise<OperationResult> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) return { success: false, error: 'Сервер удалён' };
    if (installing.has(serverId) || server.status === 'uninstalled' || server.status === 'installing') {
      return { success: false, error: 'Сервер не установлен' };
    }
    if (server.needs_apply) {
      return this.doApply(serverId);
    }

    try {
      const conf = AwgService.generateServerConfig(server, this.getServerClients(serverId));
      const credentials = this.getCredentials(server);
      const sudo = SshService.sudo(credentials);
      const command = [
        this.writeFileCommand(credentials, `${AWG_DIR}/awg0.conf`),
        `${sudo}docker exec ${CONTAINER} sh -c ${shellQuote(
          `umask 077; awg-quick strip ${AWG_DIR}/awg0.conf > /tmp/awg0.stripped && awg syncconf awg0 /tmp/awg0.stripped; rc=$?; rm -f /tmp/awg0.stripped; exit $rc`
        )}`,
      ].join(' && ');

      const result = await SshService.executeCommand(credentials, command, { input: conf, timeoutMs: 60000 });
      if (result.code !== 0) {
        throw new Error(`Ошибка синхронизации конфигурации: ${result.stderr.trim() || `код ${result.code}`}`);
      }
      db.prepare('UPDATE servers SET needs_sync = 0, last_error = NULL WHERE id = ?').run(serverId);
      return { success: true };
    } catch (err: any) {
      db.prepare('UPDATE servers SET last_error = ? WHERE id = ?').run(err.message, serverId);
      return { success: false, error: err.message };
    }
  }

  /**
   * Применить параметры интерфейса (обфускация, подсеть) — требует перезапуска интерфейса.
   * Смена порта требует пересоздания контейнера (полная переустановка).
   */
  static requestApply(serverId: number): Promise<OperationResult> {
    db.prepare('UPDATE servers SET needs_apply = 1 WHERE id = ?').run(serverId);
    return runExclusive(serverId, () => this.doApply(serverId));
  }

  private static async doApply(serverId: number): Promise<OperationResult> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) return { success: false, error: 'Сервер удалён' };
    if (installing.has(serverId) || server.status === 'uninstalled' || server.status === 'installing') {
      return { success: false, error: 'Сервер не установлен' };
    }

    if (server.deployed_port !== server.awg_port) {
      return this.doInstall(serverId);
    }

    try {
      const conf = AwgService.generateServerConfig(server, this.getServerClients(serverId));
      const credentials = this.getCredentials(server);
      const sudo = SshService.sudo(credentials);

      let result = await SshService.executeCommand(credentials, this.writeFileCommand(credentials, `${AWG_DIR}/demension.env`), {
        input: this.envFileContent(server),
        timeoutMs: 60000,
      });
      if (result.code === 0) {
        result = await SshService.executeCommand(
          credentials,
          `${this.writeFileCommand(credentials, `${AWG_DIR}/awg0.conf`)} && ${sudo}docker restart ${CONTAINER}`,
          { input: conf, timeoutMs: 120000 }
        );
      }
      if (result.code !== 0) {
        throw new Error(`Ошибка применения параметров: ${result.stderr.trim() || `код ${result.code}`}`);
      }
      db.prepare('UPDATE servers SET needs_apply = 0, needs_sync = 0, last_error = NULL WHERE id = ?').run(serverId);
      return { success: true };
    } catch (err: any) {
      db.prepare('UPDATE servers SET last_error = ? WHERE id = ?').run(err.message, serverId);
      return { success: false, error: err.message };
    }
  }

  /**
   * Остановить и удалить контейнер AmneziaWG на ноде
   */
  static async teardown(serverId: number): Promise<OperationResult> {
    return runExclusive(serverId, async () => {
      const server = loadServer(serverId);
      try {
        const credentials = this.getCredentials(server);
        const sudo = SshService.sudo(credentials);
        const result = await SshService.executeCommand(
          credentials,
          `${sudo}sh -c ${shellQuote(`docker rm -f ${CONTAINER} >/dev/null 2>&1; rm -rf ${AWG_DIR}; echo done`)}`,
          { timeoutMs: 120000 }
        );
        if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  }

  /**
   * Poll live interface stats (rx/tx, handshake), accumulate traffic and update server status
   */
  static async fetchServerStats(serverId: number): Promise<void> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server || server.status === 'uninstalled' || server.status === 'installing' || installing.has(serverId)) return;

    try {
      const credentials = this.getCredentials(server);
      const result = await SshService.executeCommand(
        credentials,
        `${SshService.sudo(credentials)}docker exec ${CONTAINER} awg show awg0 dump`,
        { timeoutMs: 30000 }
      );
      if (result.code !== 0) {
        throw new Error(`Интерфейс awg0 недоступен: ${result.stderr.trim() || `код ${result.code}`}`);
      }

      this.applyDump(serverId, result.stdout);

      const wasOnline = server.status === 'online';
      db.prepare(`
        UPDATE servers SET status = 'online', fail_count = 0, last_seen = datetime('now'),
          last_error = CASE WHEN needs_sync = 0 AND needs_apply = 0 THEN NULL ELSE last_error END
        WHERE id = ?
      `).run(serverId);

      const fresh = db.prepare('SELECT needs_sync, needs_apply FROM servers WHERE id = ?').get(serverId) as any;
      if (fresh?.needs_apply) {
        this.requestApply(serverId).catch(() => {});
      } else if (fresh?.needs_sync || !wasOnline) {
        this.requestSync(serverId).catch(() => {});
      }
    } catch (err: any) {
      if (err instanceof HostKeyMismatchError) {
        db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
        return;
      }
      db.prepare(`
        UPDATE servers SET fail_count = fail_count + 1, last_error = ?,
          status = CASE WHEN fail_count + 1 >= ? THEN 'offline' ELSE status END
        WHERE id = ?
      `).run(err.message, OFFLINE_THRESHOLD, serverId);
    }
  }

  /**
   * Разбор `awg show awg0 dump` с накоплением трафика: счётчики интерфейса сбрасываются
   * при перезапуске, поэтому к итогу прибавляется только прирост.
   * rx/tx — с точки зрения сервера: rx = отправлено клиентом (upload), tx = получено клиентом (download).
   */
  static applyDump(serverId: number, dump: string): void {
    const lines = dump.trim().split('\n');
    const select = db.prepare('SELECT id, rx_counter, tx_counter FROM clients WHERE server_id = ? AND client_public_key = ?');
    const update = db.prepare(`
      UPDATE clients SET total_rx = total_rx + ?, total_tx = total_tx + ?, rx_counter = ?, tx_counter = ?, last_handshake = COALESCE(?, last_handshake)
      WHERE id = ?
    `);

    // Line 0 is interface info; lines 1..N are peers:
    // peerPublicKey psk endpoint allowedIPs latestHandshake rxBytes txBytes persistentKeepalive
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length < 7) continue;
      const client = select.get(serverId, parts[0]) as { id: number; rx_counter: number; tx_counter: number } | undefined;
      if (!client) continue;

      const rx = parseInt(parts[5], 10) || 0;
      const tx = parseInt(parts[6], 10) || 0;
      const deltaRx = rx >= client.rx_counter ? rx - client.rx_counter : rx;
      const deltaTx = tx >= client.tx_counter ? tx - client.tx_counter : tx;
      const handshakeEpoch = parseInt(parts[4], 10);
      const handshake = handshakeEpoch > 0 ? new Date(handshakeEpoch * 1000).toISOString() : null;

      update.run(deltaRx, deltaTx, rx, tx, handshake, client.id);
    }
  }
}
