import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, transaction } from '../db/index.js';
import { SshService, SshCredentials, HostKeyMismatchError } from './ssh.service.js';
import { AwgService } from './awg.service.js';
import { decryptSecret } from './secrets.service.js';
import { shellQuote, parseSubnet } from '../utils/net.js';
import { parseServerConfig, paramsToColumns, ParsedServerConfig } from '../utils/awg-params.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Контейнер, разворачиваемый панелью */
const PANEL_CONTAINER = 'amnezia-awg';
/** На ноды всегда ставится актуальный образ AmneziaWG (docker pull при каждой установке/переустановке) */
export const AWG_IMAGE = 'amneziavpn/amneziawg-go:latest';
const AWG_DIR = '/opt/amnezia/awg';
const PANEL_CONF = `${AWG_DIR}/awg0.conf`;
/** Сколько неудачных опросов подряд переводят сервер в offline */
const OFFLINE_THRESHOLD = 3;

export interface OperationResult {
  success: boolean;
  error?: string;
}

export interface DetectedContainer {
  name: string;
  image: string;
  running: boolean;
  confPath: string | null;
  tool: 'awg' | 'wg';
  managedBy: 'demension' | 'amnezia';
  config: string | null;
  clientNames: Record<string, string>;
}

export interface ScanResult {
  /** Найден работающий контейнер с конфигурацией, который можно подключить без установки */
  found: boolean;
  containers: { name: string; image: string; running: boolean; managedBy: string }[];
  message: string;
  adopted?: {
    container: string;
    managedBy: string;
    awgVersion: number;
    port: number;
    subnet: string;
    importedPeers: number;
    skippedPeers: number;
  };
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

/**
 * Разбор вывода скрипта сканирования (маркеры ---CONTAINER / ---CONF / ---TOOL / ---CLIENTS / ---DEMENSION)
 */
export function parseScanOutput(output: string): DetectedContainer[] {
  const containers: DetectedContainer[] = [];
  let current: DetectedContainer | null = null;
  let mode: 'conf' | 'clients' | null = null;
  let buffer: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (mode) {
      if ((mode === 'conf' && line === '---ENDCONF') || (mode === 'clients' && line === '---ENDCLIENTS')) {
        if (current && mode === 'conf') current.config = buffer.join('\n');
        if (current && mode === 'clients') {
          try {
            const table = JSON.parse(buffer.join('\n'));
            for (const entry of Array.isArray(table) ? table : []) {
              const name = entry?.userData?.clientName;
              if (entry?.clientId && typeof name === 'string' && name.trim()) current.clientNames[entry.clientId] = name.trim();
            }
          } catch {
            // clientsTable не JSON — имена не импортируются
          }
        }
        mode = null;
        buffer = [];
      } else {
        buffer.push(line);
      }
      continue;
    }

    if (line.startsWith('---CONTAINER ')) {
      const [name, image, running] = line.slice('---CONTAINER '.length).split('|');
      current = {
        name,
        image: image || '',
        running: running === 'true',
        confPath: null,
        tool: 'awg',
        managedBy: 'amnezia',
        config: null,
        clientNames: {},
      };
      containers.push(current);
    } else if (current && line.startsWith('---CONF ')) {
      current.confPath = line.slice('---CONF '.length).trim();
      mode = 'conf';
    } else if (current && line.startsWith('---TOOL ')) {
      current.tool = line.includes('awg') ? 'awg' : 'wg';
    } else if (current && line === '---CLIENTS') {
      mode = 'clients';
    } else if (current && line === '---DEMENSION') {
      current.managedBy = 'demension';
    }
  }
  return containers;
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

  private static container(server: any) {
    const tool = server.awg_tool === 'wg' ? 'wg' : 'awg';
    return {
      name: String(server.container_name || PANEL_CONTAINER),
      iface: String(server.iface || 'awg0'),
      confPath: String(server.conf_path || PANEL_CONF),
      tool,
      quick: `${tool}-quick`,
    };
  }

  /**
   * Команда, атомарно записывающая stdin в конфиг внутри контейнера.
   * Для контейнера панели /opt/amnezia/awg смонтирован с хоста, для контейнера Amnezia — живёт внутри.
   */
  private static writeConfigCommand(credentials: SshCredentials, server: any): string {
    const c = this.container(server);
    const inner = `umask 077 && cat > ${c.confPath}.new && mv -f ${c.confPath}.new ${c.confPath}`;
    return `${SshService.sudo(credentials)}docker exec -i ${shellQuote(c.name)} sh -c ${shellQuote(inner)}`;
  }

  private static writeHostFileCommand(credentials: SshCredentials, remotePath: string): string {
    const tmp = `${remotePath}.new`;
    return `${SshService.sudo(credentials)}sh -c ${shellQuote(`umask 077 && mkdir -p ${AWG_DIR} && cat > ${tmp} && mv -f ${tmp} ${remotePath}`)}`;
  }

  private static envFileContent(server: any): string {
    return `AWG_NETWORK=${AwgService.getTunnelNetwork(server.subnet)}\nAWG_PORT=${server.awg_port}\n`;
  }

  // ==============================================================================
  // Сканирование ноды и подключение уже установленного AmneziaWG
  // ==============================================================================

  /**
   * Ищет на ноде контейнеры AmneziaWG (панели или приложения Amnezia) и читает их конфигурацию
   */
  static async detectContainers(server: any): Promise<DetectedContainer[]> {
    const script = [
      'command -v docker >/dev/null 2>&1 || exit 0',
      'for c in $(docker ps -a --format "{{.Names}}"); do',
      '  img=$(docker inspect -f "{{.Config.Image}}" "$c" 2>/dev/null)',
      '  case "$c|$img" in *amnezia-awg*|*amneziawg*) ;; *) continue ;; esac',
      '  running=$(docker inspect -f "{{.State.Running}}" "$c" 2>/dev/null)',
      '  echo "---CONTAINER $c|$img|$running"',
      '  [ "$running" = "true" ] || continue',
      `  for f in ${AWG_DIR}/awg0.conf ${AWG_DIR}/wg0.conf; do`,
      '    if docker exec "$c" test -f "$f"; then echo "---CONF $f"; docker exec "$c" cat "$f"; echo; echo "---ENDCONF"; break; fi',
      '  done',
      '  if docker exec "$c" sh -c "command -v awg" >/dev/null 2>&1; then echo "---TOOL awg"; else echo "---TOOL wg"; fi',
      `  if docker exec "$c" test -f ${AWG_DIR}/clientsTable; then echo "---CLIENTS"; docker exec "$c" cat ${AWG_DIR}/clientsTable; echo; echo "---ENDCLIENTS"; fi`,
      `  if [ "$c" = "${PANEL_CONTAINER}" ] && [ -f ${AWG_DIR}/demension.env ]; then echo "---DEMENSION"; fi`,
      'done',
    ].join('\n');

    const credentials = this.getCredentials(server);
    const result = await SshService.executeCommand(credentials, `${SshService.sudo(credentials)}sh -c ${shellQuote(script)}`, {
      timeoutMs: 60000,
    });
    if (result.code !== 0) {
      const hint = /sudo: a (terminal|password) is required/.test(result.stderr) ? ' (нужен sudo без пароля)' : '';
      throw new Error(`Не удалось просканировать сервер${hint}: ${result.stderr.trim() || `код ${result.code}`}`);
    }
    return parseScanOutput(result.stdout);
  }

  /**
   * Сканирует ноду и, если AmneziaWG уже установлен, подключает его к панели без переустановки
   */
  static async scanAndAdopt(serverId: number): Promise<ScanResult> {
    return runExclusive(serverId, async () => {
      const server = loadServer(serverId);
      const detected = await this.detectContainers(server);
      const containers = detected.map((d) => ({ name: d.name, image: d.image, running: d.running, managedBy: d.managedBy }));

      // Предпочтение — контейнеру панели, затем любому работающему с конфигурацией
      const candidates = detected.filter((d) => d.running && d.config);
      const target = candidates.find((d) => d.managedBy === 'demension') || candidates[0];
      if (!target) {
        const stopped = detected.filter((d) => !d.running).map((d) => d.name);
        return {
          found: false,
          containers,
          message: stopped.length
            ? `Найдены остановленные контейнеры AmneziaWG (${stopped.join(', ')}) — требуется установка`
            : 'AmneziaWG на сервере не найден — требуется установка',
        };
      }

      let parsed: ParsedServerConfig;
      try {
        parsed = parseServerConfig(target.config as string);
      } catch (err: any) {
        return { found: false, containers, message: `Контейнер ${target.name} найден, но его конфигурацию не удалось разобрать: ${err.message}` };
      }

      const adopted = this.adoptConfig(server, target, parsed);
      const others = candidates.filter((c) => c !== target).map((c) => c.name);
      const owner = target.managedBy === 'amnezia' ? 'приложения Amnezia' : 'панели';
      return {
        found: true,
        containers,
        adopted,
        message:
          `Найден работающий AmneziaWG ${owner} (контейнер ${target.name}). Сервер подключён без переустановки, ` +
          `импортировано клиентов: ${adopted.importedPeers}.` +
          (others.length ? ` Другие контейнеры AmneziaWG на сервере: ${others.join(', ')}.` : ''),
      };
    });
  }

  private static adoptConfig(server: any, target: DetectedContainer, parsed: ParsedServerConfig): NonNullable<ScanResult['adopted']> {
    // Подсеть Amnezia задаётся адресом сети (10.8.1.0/24) — проверяем мягко
    parseSubnet(parsed.address, false);
    const iface = path.basename(target.confPath as string, '.conf');
    const publicKey = AwgService.derivePublicKey(parsed.privateKey);
    const serverPsk = parsed.peers.find((p) => p.presharedKey)?.presharedKey || server.preshared_key;
    const columns = paramsToColumns(parsed.params);

    let imported = 0;
    let skipped = 0;
    transaction(() => {
      const assignments = Object.keys(columns).map((k) => `${k} = ?`).join(', ');
      db.prepare(`
        UPDATE servers SET ${assignments},
          awg_port = ?, deployed_port = ?, subnet = ?, server_private_key = ?, server_public_key = ?, preshared_key = ?,
          container_name = ?, iface = ?, conf_path = ?, awg_tool = ?, managed_by = ?,
          status = 'online', needs_sync = 0, needs_apply = 0, fail_count = 0, last_error = NULL, last_seen = datetime('now')
        WHERE id = ?
      `).run(
        ...(Object.values(columns) as any[]),
        parsed.listenPort, parsed.listenPort, parsed.address, parsed.privateKey, publicKey, serverPsk,
        target.name, iface, target.confPath, target.tool, target.managedBy,
        server.id
      );

      const existing = db.prepare('SELECT client_public_key, client_ip FROM clients WHERE server_id = ?').all(server.id) as any[];
      const knownKeys = new Set(existing.map((c) => c.client_public_key));
      const usedIps = new Set(existing.map((c) => c.client_ip));
      const insert = db.prepare(`
        INSERT INTO clients (server_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled, external)
        VALUES (?, ?, ?, ?, '', ?, 1, 1)
      `);
      for (const peer of parsed.peers) {
        if (knownKeys.has(peer.publicKey)) continue;
        if (!peer.ip || usedIps.has(peer.ip)) {
          skipped++;
          continue;
        }
        const name = target.clientNames[peer.publicKey] || `Импорт ${peer.ip}`;
        insert.run(server.id, name.slice(0, 64), peer.ip, peer.publicKey, peer.presharedKey);
        usedIps.add(peer.ip);
        imported++;
      }
    });

    return {
      container: target.name,
      managedBy: target.managedBy,
      awgVersion: parsed.params.awg_version,
      port: parsed.listenPort,
      subnet: parsed.address,
      importedPeers: imported,
      skippedPeers: skipped,
    };
  }

  // ==============================================================================
  // Установка
  // ==============================================================================

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

      // Ранее подключённый чужой контейнер (например, приложения Amnezia) заменяется контейнером панели —
      // ключи, параметры и клиенты переносятся из БД, поэтому выданные конфигурации продолжают работать
      const replaceContainer =
        server.container_name && server.container_name !== PANEL_CONTAINER ? String(server.container_name) : '';
      if (replaceContainer) log(`Контейнер ${replaceContainer} будет заменён контейнером панели ${PANEL_CONTAINER}\r\n`);

      const conf = AwgService.generateServerConfig(fullServer, this.getServerClients(serverId));
      const script = [
        `export AWG_PORT=${shellQuote(server.awg_port)}`,
        `export AWG_NETWORK=${shellQuote(AwgService.getTunnelNetwork(server.subnet))}`,
        `export AWG_CONF_B64=${shellQuote(Buffer.from(conf).toString('base64'))}`,
        `export AWG_IMAGE=${shellQuote(AWG_IMAGE)}`,
        `export REPLACE_CONTAINER=${shellQuote(replaceContainer)}`,
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
            container_name = ?,
            iface = 'awg0',
            conf_path = ?,
            awg_tool = 'awg',
            managed_by = 'demension',
            needs_sync = 0,
            needs_apply = 0,
            fail_count = 0,
            last_error = NULL,
            last_seen = datetime('now')
        WHERE id = ?
      `).run(pubKey, privKey, psk, PANEL_CONTAINER, PANEL_CONF, serverId);

      log('\r\n=== AmneziaWG успешно установлен и готов к работе! ===\r\n');
      return { success: true };
    } catch (err: any) {
      db.prepare("UPDATE servers SET status = 'error', last_error = ? WHERE id = ?").run(err.message, serverId);
      log(`\r\n❌ Ошибка: ${err.message}\r\n`);
      return { success: false, error: err.message };
    }
  }

  // ==============================================================================
  // Синхронизация пиров и применение параметров
  // ==============================================================================

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
      const c = this.container(server);
      const command = [
        this.writeConfigCommand(credentials, server),
        `${SshService.sudo(credentials)}docker exec ${shellQuote(c.name)} sh -c ${shellQuote(
          `umask 077; ${c.quick} strip ${c.confPath} > /tmp/awg.stripped && ${c.tool} syncconf ${c.iface} /tmp/awg.stripped; rc=$?; rm -f /tmp/awg.stripped; exit $rc`
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
   * Применить параметры интерфейса (обфускация) — требует перезапуска интерфейса.
   * Смена порта или подсети требует пересоздания контейнера (переустановка контейнером панели).
   */
  static requestApply(serverId: number): Promise<OperationResult> {
    db.prepare('UPDATE servers SET needs_apply = 1 WHERE id = ?').run(serverId);
    return runExclusive(serverId, () => this.doApply(serverId));
  }

  /**
   * Переустановка с актуальным образом (обновление AmneziaWG или переход на новую версию протокола)
   */
  static requestReinstall(serverId: number): Promise<OperationResult> {
    if (installing.has(serverId)) return Promise.resolve({ success: false, error: 'Установка уже выполняется' });
    installing.add(serverId);
    return runExclusive(serverId, () => this.doInstall(serverId)).finally(() => installing.delete(serverId));
  }

  private static async doApply(serverId: number): Promise<OperationResult> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server) return { success: false, error: 'Сервер удалён' };
    if (installing.has(serverId) || server.status === 'uninstalled' || server.status === 'installing') {
      return { success: false, error: 'Сервер не установлен' };
    }

    // Порт проброшен при создании контейнера; NAT контейнера Amnezia настроен на исходную подсеть
    if (server.deployed_port !== server.awg_port) {
      return this.doInstall(serverId);
    }

    try {
      const conf = AwgService.generateServerConfig(server, this.getServerClients(serverId));
      const credentials = this.getCredentials(server);
      const c = this.container(server);

      if (server.managed_by === 'demension') {
        const env = await SshService.executeCommand(credentials, this.writeHostFileCommand(credentials, `${AWG_DIR}/demension.env`), {
          input: this.envFileContent(server),
          timeoutMs: 60000,
        });
        if (env.code !== 0) throw new Error(env.stderr.trim() || `код ${env.code}`);
      }

      const result = await SshService.executeCommand(
        credentials,
        `${this.writeConfigCommand(credentials, server)} && ${SshService.sudo(credentials)}docker restart ${shellQuote(c.name)}`,
        { input: conf, timeoutMs: 120000 }
      );
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
        const c = this.container(server);
        const cleanup = server.managed_by === 'demension' ? `; rm -rf ${AWG_DIR}` : '';
        const result = await SshService.executeCommand(
          credentials,
          `${SshService.sudo(credentials)}sh -c ${shellQuote(`docker rm -f ${c.name} >/dev/null 2>&1${cleanup}; echo done`)}`,
          { timeoutMs: 120000 }
        );
        if (result.code !== 0) throw new Error(result.stderr.trim() || `код ${result.code}`);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  }

  // ==============================================================================
  // Мониторинг
  // ==============================================================================

  /**
   * Poll live interface stats (rx/tx, handshake), accumulate traffic and update server status
   */
  static async fetchServerStats(serverId: number): Promise<void> {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    if (!server || server.status === 'uninstalled' || server.status === 'installing' || installing.has(serverId)) return;

    try {
      const credentials = this.getCredentials(server);
      const c = this.container(server);
      const result = await SshService.executeCommand(
        credentials,
        `${SshService.sudo(credentials)}docker exec ${shellQuote(c.name)} ${c.tool} show ${c.iface} dump`,
        { timeoutMs: 30000 }
      );
      if (result.code !== 0) {
        throw new Error(`Интерфейс ${c.iface} недоступен: ${result.stderr.trim() || `код ${result.code}`}`);
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
   * Разбор `awg show <iface> dump` с накоплением трафика: счётчики интерфейса сбрасываются
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
