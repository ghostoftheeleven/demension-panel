import { Router } from 'express';
import { db } from '../db/index.js';
import { AwgService, AwgParams } from '../services/awg.service.js';
import { SshService } from '../services/ssh.service.js';
import { ProvisionService } from '../services/provision.service.js';
import { encryptSecret } from '../services/secrets.service.js';
import { asyncHandler, HttpError, parseId } from '../utils/http.js';
import { isValidHost, isValidPort, parseSubnet } from '../utils/net.js';
import { LATEST_AWG_VERSION, paramsFromRow, paramsToColumns } from '../utils/awg-params.js';

export const serversRouter = Router();

/** Параметры обфускации, редактируемые через PUT (версия протокола меняется отдельным действием) */
const INT_PARAM_KEYS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'] as const;
const TEXT_PARAM_KEYS = ['h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5', 'header_protection_key'] as const;

/**
 * Представление сервера для фронтенда — без паролей и приватных ключей
 */
export function serializeServer(s: any) {
  if (!s) return s;
  const { ssh_password, ssh_key, server_private_key, preshared_key, extra_params, ...rest } = s;
  const params = paramsFromRow(s);
  const remotePanel = s.remote_panel_id
    ? (db.prepare('SELECT name, status FROM remote_panels WHERE id = ?').get(s.remote_panel_id) as any)
    : null;
  return {
    ...rest,
    ...params,
    latest_awg_version: LATEST_AWG_VERSION,
    remote_panel_name: remotePanel?.name ?? null,
    remote_panel_status: remotePanel?.status ?? null,
    has_ssh_password: Boolean(ssh_password),
    has_ssh_key: Boolean(ssh_key),
    needs_sync: Boolean(s.needs_sync),
    needs_apply: Boolean(s.needs_apply),
    installing: ProvisionService.isInstalling(s.id),
  };
}

function getServerOr404(id: number): any {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
  if (!server) throw new HttpError(404, 'Сервер не найден');
  return server;
}

/**
 * Нодами партнёра управляет панель владельца: SSH, установка и параметры здесь недоступны
 */
function getLocalServerOr404(id: number): any {
  const server = getServerOr404(id);
  if (server.remote_panel_id) {
    throw new HttpError(400, 'Это нода партнёра: её настройками управляет владелец. Отключить её можно в разделе «Партнёры».');
  }
  return server;
}

function selectServerWithCounts(id: number) {
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id) as client_count,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id AND enabled = 1) as active_client_count
    FROM servers s WHERE s.id = ?
  `).get(id);
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Имя сервера обязательно');
  if (name.trim().length > 64) throw new HttpError(400, 'Имя сервера не длиннее 64 символов');
  return name.trim();
}

function validateSshUser(user: unknown): string {
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) {
    throw new HttpError(400, 'Некорректное имя SSH-пользователя');
  }
  return user;
}

function validatePort(value: unknown, label: string): number {
  const port = Number(value);
  if (!isValidPort(port)) throw new HttpError(400, `${label} должен быть числом от 1 до 65535`);
  return port;
}

function validateSubnet(value: unknown): string {
  try {
    parseSubnet(String(value));
    return String(value).trim();
  } catch (err: any) {
    throw new HttpError(400, err.message);
  }
}

function validateKey(value: unknown): string {
  if (typeof value !== 'string' || !value.includes('PRIVATE KEY')) {
    throw new HttpError(400, 'SSH-ключ должен быть в формате PEM/OpenSSH (-----BEGIN ... PRIVATE KEY-----)');
  }
  return value.trim() + '\n';
}

// GET all servers
serversRouter.get('/', (req, res) => {
  const servers = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id) as client_count,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id AND enabled = 1) as active_client_count
    FROM servers s
    ORDER BY s.id DESC
  `).all();
  res.json(servers.map(serializeServer));
});

// GET single server
serversRouter.get('/:id', (req, res) => {
  const id = parseId(req.params.id);
  getServerOr404(id);
  res.json(serializeServer(selectServerWithCounts(id)));
});

// POST create server
serversRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const name = validateName(body.name);
  if (!isValidHost(body.host)) throw new HttpError(400, 'Укажите корректный IP-адрес или домен сервера');
  const host = String(body.host).trim();
  const sshPort = validatePort(body.ssh_port ?? 22, 'SSH-порт');
  const sshUser = validateSshUser(body.ssh_user ?? 'root');
  const awgPort = validatePort(body.awg_port ?? 51820, 'Порт AmneziaWG');
  const subnet = validateSubnet(body.subnet ?? '10.8.0.1/24');
  const sshKey = body.ssh_key ? validateKey(body.ssh_key) : null;
  const sshPassword = typeof body.ssh_password === 'string' && body.ssh_password ? body.ssh_password : null;
  if (!sshKey && !sshPassword) throw new HttpError(400, 'Укажите SSH-пароль или приватный ключ');

  // Generate randomized AmneziaWG obfuscation parameters
  const params = AwgService.generateRandomParams();
  const keyPair = AwgService.generateKeyPair();
  const psk = AwgService.generatePresharedKey();

  const columns = paramsToColumns(params);
  const result = db.prepare(`
    INSERT INTO servers (
      name, host, ssh_port, ssh_user, ssh_password, ssh_key,
      awg_port, subnet, server_public_key, server_private_key, preshared_key, status,
      ${Object.keys(columns).join(', ')}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uninstalled', ${Object.keys(columns).map(() => '?').join(', ')})
  `).run(
    name, host, sshPort, sshUser, encryptSecret(sshPassword), encryptSecret(sshKey),
    awgPort, subnet, keyPair.publicKey, keyPair.privateKey, psk,
    ...(Object.values(columns) as any[])
  );

  res.status(201).json(serializeServer(selectServerWithCounts(Number(result.lastInsertRowid))));
});

// PUT update server
serversRouter.put('/:id', (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);
  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) updates.name = validateName(body.name);
  if (body.host !== undefined) {
    if (!isValidHost(body.host)) throw new HttpError(400, 'Укажите корректный IP-адрес или домен сервера');
    updates.host = String(body.host).trim();
    if (updates.host !== server.host) updates.host_key = null;
  }
  if (body.ssh_port !== undefined) updates.ssh_port = validatePort(body.ssh_port, 'SSH-порт');
  if (body.ssh_user !== undefined) updates.ssh_user = validateSshUser(body.ssh_user);

  // Аутентификация: auth_type переключает способ, старый секрет очищается
  if (body.auth_type === 'password') {
    if (!body.ssh_password) throw new HttpError(400, 'Укажите SSH-пароль');
    updates.ssh_password = encryptSecret(String(body.ssh_password));
    updates.ssh_key = null;
  } else if (body.auth_type === 'key') {
    updates.ssh_key = encryptSecret(validateKey(body.ssh_key));
    updates.ssh_password = null;
  }
  if (body.reset_host_key === true) updates.host_key = null;

  let interfaceChanged = false;
  if (body.awg_port !== undefined) {
    updates.awg_port = validatePort(body.awg_port, 'Порт AmneziaWG');
    interfaceChanged ||= updates.awg_port !== server.awg_port;
  }
  if (body.subnet !== undefined) {
    updates.subnet = validateSubnet(body.subnet);
    if (updates.subnet !== server.subnet) {
      const count = (db.prepare('SELECT COUNT(*) as c FROM clients WHERE server_id = ?').get(id) as { c: number }).c;
      if (count > 0) throw new HttpError(400, 'Нельзя изменить подсеть, пока на сервере есть клиенты');
      interfaceChanged = true;
    }
  }

  const current = paramsFromRow(server);
  const params: AwgParams = { ...current };
  let paramsTouched = false;
  for (const key of INT_PARAM_KEYS) {
    if (body[key] !== undefined) {
      const value = body[key] === null || body[key] === '' ? null : Number(body[key]);
      (params as any)[key] = key === 's3' || key === 's4' ? value : Number(value);
      paramsTouched = true;
    }
  }
  for (const key of TEXT_PARAM_KEYS) {
    if (body[key] !== undefined) {
      const value = body[key] === null ? '' : String(body[key]).trim();
      (params as any)[key] = key.startsWith('h') && key.length === 2 ? value : value || null;
      paramsTouched = true;
    }
  }
  if (paramsTouched) {
    const error = AwgService.validateParams(params);
    if (error) throw new HttpError(400, error);
    const before = paramsToColumns(current);
    const after = paramsToColumns(params);
    for (const [key, value] of Object.entries(after)) {
      if (value !== before[key]) {
        updates[key] = value;
        interfaceChanged = true;
      }
    }
  }

  const keys = Object.keys(updates);
  if (keys.length > 0) {
    db.prepare(`UPDATE servers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...(keys.map((k) => updates[k]) as any[]),
      id
    );
  }

  const installed = server.status !== 'uninstalled';
  if (interfaceChanged && installed) {
    ProvisionService.requestApply(id).catch(() => {});
  }

  res.json(serializeServer(selectServerWithCounts(id)));
});

// DELETE server (?teardown=1 — остановить и удалить контейнер на ноде; ?force=1 — удалить из панели даже при ошибке)
serversRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);
  if (ProvisionService.isInstalling(id)) throw new HttpError(409, 'Дождитесь окончания установки');

  if (req.query.teardown === '1' && server.status !== 'uninstalled') {
    const result = await ProvisionService.teardown(id);
    if (!result.success && req.query.force !== '1') {
      throw new HttpError(
        502,
        `Не удалось остановить AmneziaWG на ноде: ${result.error}. VPN на сервере продолжит работать — удалите принудительно или остановите контейнер вручную.`
      );
    }
  }

  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  res.json({ success: true, message: 'Сервер удален из панели' });
}));

// POST test SSH connection
serversRouter.post('/:id/test-ssh', asyncHandler(async (req, res) => {
  const server = getLocalServerOr404(parseId(req.params.id));
  const result = await SshService.testConnection(ProvisionService.getCredentials(server));
  res.json(result);
}));

// POST randomize AWG parameters (and apply them on the node)
serversRouter.post('/:id/randomize-params', (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);

  // Новые случайные значения в рамках текущей версии протокола; I1–I5 и доп. параметры сохраняются
  const current = paramsFromRow(server);
  const generated = AwgService.generateRandomParams(current.awg_version);
  const params: AwgParams = {
    ...generated,
    i1: current.i1, i2: current.i2, i3: current.i3, i4: current.i4, i5: current.i5,
    extra_params: current.extra_params,
  };
  const columns = paramsToColumns(params);
  db.prepare(`UPDATE servers SET ${Object.keys(columns).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...(Object.values(columns) as any[]),
    id
  );

  if (server.status !== 'uninstalled') {
    ProvisionService.requestApply(id).catch(() => {});
  }

  res.json(serializeServer(selectServerWithCounts(id)));
});

// POST sync peers to server
serversRouter.post('/:id/sync', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getServerOr404(id);
  const result = await ProvisionService.syncPeers(id);
  res.status(result.success ? 200 : 502).json(result);
}));

// POST apply interface parameters (restart AmneziaWG on the node)
serversRouter.post('/:id/apply', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getLocalServerOr404(id);
  const result = await ProvisionService.requestApply(id);
  res.status(result.success ? 200 : 502).json(result);
}));

// POST scan — поиск уже установленного AmneziaWG (контейнера панели или приложения Amnezia) и подключение без установки
serversRouter.post('/:id/scan', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  getLocalServerOr404(id);
  if (ProvisionService.isInstalling(id)) throw new HttpError(409, 'Дождитесь окончания установки');
  try {
    const result = await ProvisionService.scanAndAdopt(id);
    res.json({ ...result, server: serializeServer(selectServerWithCounts(id)) });
  } catch (err: any) {
    throw new HttpError(502, err.message);
  }
}));

// POST upgrade-protocol — переход на актуальную версию AmneziaWG: новые параметры и переустановка с latest-образом
serversRouter.post('/:id/upgrade-protocol', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const server = getLocalServerOr404(id);
  const current = paramsFromRow(server);
  if (current.awg_version === LATEST_AWG_VERSION) throw new HttpError(400, 'Сервер уже использует актуальную версию протокола');

  const params: AwgParams = {
    ...AwgService.generateRandomParams(LATEST_AWG_VERSION),
    i1: current.i1, i2: current.i2, i3: current.i3, i4: current.i4, i5: current.i5,
  };
  const columns = paramsToColumns(params);
  db.prepare(`UPDATE servers SET ${Object.keys(columns).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...(Object.values(columns) as any[]),
    id
  );

  if (server.status === 'uninstalled') {
    return res.json({ success: true, server: serializeServer(selectServerWithCounts(id)) });
  }
  const result = await ProvisionService.requestReinstall(id);
  if (!result.success) {
    // Нода осталась на прежних параметрах — возвращаем их, чтобы подписки не раздавали несовместимые конфиги
    const previous = paramsToColumns(current);
    db.prepare(`UPDATE servers SET ${Object.keys(previous).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...(Object.values(previous) as any[]),
      id
    );
    result.error = `${result.error}. Параметры возвращены к прежним (AmneziaWG ${current.awg_version}.x).`;
  }
  res.status(result.success ? 200 : 502).json({ ...result, server: serializeServer(selectServerWithCounts(id)) });
}));
