import { Router } from 'express';
import { db } from '../db/index.js';
import { AwgService, AwgParams } from '../services/awg.service.js';
import { SshService } from '../services/ssh.service.js';
import { ProvisionService } from '../services/provision.service.js';
import { encryptSecret } from '../services/secrets.service.js';
import { asyncHandler, HttpError, parseId } from '../utils/http.js';
import { isValidHost, isValidPort, parseSubnet } from '../utils/net.js';

export const serversRouter = Router();

const PARAM_KEYS: (keyof AwgParams)[] = ['jc', 'jmin', 'jmax', 's1', 's2', 'h1', 'h2', 'h3', 'h4'];

/**
 * Представление сервера для фронтенда — без паролей и приватных ключей
 */
export function serializeServer(s: any) {
  if (!s) return s;
  const { ssh_password, ssh_key, server_private_key, preshared_key, ...rest } = s;
  return {
    ...rest,
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

  const result = db.prepare(`
    INSERT INTO servers (
      name, host, ssh_port, ssh_user, ssh_password, ssh_key,
      awg_port, subnet, server_public_key, server_private_key, preshared_key,
      jc, jmin, jmax, s1, s2, h1, h2, h3, h4, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uninstalled')
  `).run(
    name, host, sshPort, sshUser, encryptSecret(sshPassword), encryptSecret(sshKey),
    awgPort, subnet, keyPair.publicKey, keyPair.privateKey, psk,
    params.jc, params.jmin, params.jmax, params.s1, params.s2,
    params.h1, params.h2, params.h3, params.h4
  );

  res.status(201).json(serializeServer(selectServerWithCounts(Number(result.lastInsertRowid))));
});

// PUT update server
serversRouter.put('/:id', (req, res) => {
  const id = parseId(req.params.id);
  const server = getServerOr404(id);
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

  const params = Object.fromEntries(PARAM_KEYS.map((k) => [k, server[k]])) as unknown as AwgParams;
  let paramsTouched = false;
  for (const key of PARAM_KEYS) {
    if (body[key] !== undefined) {
      params[key] = Number(body[key]);
      paramsTouched = true;
    }
  }
  if (paramsTouched) {
    const error = AwgService.validateParams(params);
    if (error) throw new HttpError(400, error);
    for (const key of PARAM_KEYS) {
      if (params[key] !== server[key]) {
        updates[key] = params[key];
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
  const server = getServerOr404(id);
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
  const server = getServerOr404(parseId(req.params.id));
  const result = await SshService.testConnection(ProvisionService.getCredentials(server));
  res.json(result);
}));

// POST randomize AWG parameters (and apply them on the node)
serversRouter.post('/:id/randomize-params', (req, res) => {
  const id = parseId(req.params.id);
  const server = getServerOr404(id);

  const params = AwgService.generateRandomParams();
  db.prepare(`
    UPDATE servers SET
      jc = ?, jmin = ?, jmax = ?, s1 = ?, s2 = ?,
      h1 = ?, h2 = ?, h3 = ?, h4 = ?
    WHERE id = ?
  `).run(
    params.jc, params.jmin, params.jmax, params.s1, params.s2,
    params.h1, params.h2, params.h3, params.h4,
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
  getServerOr404(id);
  const result = await ProvisionService.requestApply(id);
  res.status(result.success ? 200 : 502).json(result);
}));
