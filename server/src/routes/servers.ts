import { Router } from 'express';
import { db } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { SshService } from '../services/ssh.service.js';
import { ProvisionService } from '../services/provision.service.js';

export const serversRouter = Router();

// GET all servers
serversRouter.get('/', (req, res) => {
  const servers = db.prepare(`
    SELECT s.*, 
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id) as client_count,
      (SELECT COUNT(*) FROM clients WHERE server_id = s.id AND enabled = 1) as active_client_count
    FROM servers s
    ORDER BY s.id DESC
  `).all();
  res.json(servers);
});

// GET single server
serversRouter.get('/:id', (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) {
    return res.status(404).json({ error: 'Сервер не найден' });
  }
  res.json(server);
});

// POST create server
serversRouter.post('/', (req, res) => {
  const {
    name,
    host,
    ssh_port = 22,
    ssh_user = 'root',
    ssh_password,
    ssh_key,
    awg_port = 51820,
    subnet = '10.8.0.1/24',
  } = req.body;

  if (!name || !host) {
    return res.status(400).json({ error: 'Имя и хост сервера обязательны' });
  }

  // Generate randomized AmneziaWG obfuscation parameters
  const params = AwgService.generateRandomParams();
  const keyPair = AwgService.generateKeyPair();
  const psk = AwgService.generatePresharedKey();

  const stmt = db.prepare(`
    INSERT INTO servers (
      name, host, ssh_port, ssh_user, ssh_password, ssh_key,
      awg_port, subnet, server_public_key, server_private_key, preshared_key,
      jc, jmin, jmax, s1, s2, h1, h2, h3, h4, status
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uninstalled'
    )
  `);

  const result = stmt.run(
    name, host, ssh_port, ssh_user, ssh_password || null, ssh_key || null,
    awg_port, subnet, keyPair.publicKey, keyPair.privateKey, psk,
    params.jc, params.jmin, params.jmax, params.s1, params.s2,
    params.h1, params.h2, params.h3, params.h4
  );

  const newServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newServer);
});

// PUT update server
serversRouter.put('/:id', (req, res) => {
  const {
    name, host, ssh_port, ssh_user, ssh_password, ssh_key,
    awg_port, subnet, jc, jmin, jmax, s1, s2, h1, h2, h3, h4
  } = req.body;

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
  if (!server) {
    return res.status(404).json({ error: 'Сервер не найден' });
  }

  db.prepare(`
    UPDATE servers SET
      name = COALESCE(?, name),
      host = COALESCE(?, host),
      ssh_port = COALESCE(?, ssh_port),
      ssh_user = COALESCE(?, ssh_user),
      ssh_password = COALESCE(?, ssh_password),
      ssh_key = COALESCE(?, ssh_key),
      awg_port = COALESCE(?, awg_port),
      subnet = COALESCE(?, subnet),
      jc = COALESCE(?, jc),
      jmin = COALESCE(?, jmin),
      jmax = COALESCE(?, jmax),
      s1 = COALESCE(?, s1),
      s2 = COALESCE(?, s2),
      h1 = COALESCE(?, h1),
      h2 = COALESCE(?, h2),
      h3 = COALESCE(?, h3),
      h4 = COALESCE(?, h4)
    WHERE id = ?
  `).run(
    name ?? null, host ?? null, ssh_port ?? null, ssh_user ?? null, ssh_password ?? null, ssh_key ?? null,
    awg_port ?? null, subnet ?? null, jc ?? null, jmin ?? null, jmax ?? null, s1 ?? null, s2 ?? null, h1 ?? null, h2 ?? null, h3 ?? null, h4 ?? null,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE server
serversRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM servers WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Сервер удален из панели' });
});

// POST test SSH connection
serversRouter.post('/:id/test-ssh', async (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const result = await SshService.testConnection({
    host: server.host,
    port: server.ssh_port,
    username: server.ssh_user,
    password: server.ssh_password,
    privateKey: server.ssh_key,
  });

  res.json(result);
});

// POST randomize AWG parameters
serversRouter.post('/:id/randomize-params', (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as any;
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const params = AwgService.generateRandomParams();
  db.prepare(`
    UPDATE servers SET
      jc = ?, jmin = ?, jmax = ?, s1 = ?, s2 = ?,
      h1 = ?, h2 = ?, h3 = ?, h4 = ?
    WHERE id = ?
  `).run(
    params.jc, params.jmin, params.jmax, params.s1, params.s2,
    params.h1, params.h2, params.h3, params.h4,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// POST sync peers to server
serversRouter.post('/:id/sync', async (req, res) => {
  try {
    const result = await ProvisionService.syncPeers(Number(req.params.id));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
