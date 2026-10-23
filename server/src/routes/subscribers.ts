import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { ProvisionService } from '../services/provision.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';

export const subscribersRouter = Router();

// All routes here require authentication
subscribersRouter.use(requireAuth);

// GET /api/subscribers
subscribersRouter.get('/', (req, res) => {
  const subscribers = db.prepare(`
    SELECT 
      s.*,
      COALESCE(SUM(c.total_rx), 0) as total_rx,
      COALESCE(SUM(c.total_tx), 0) as total_tx,
      COUNT(c.id) as peer_count
    FROM subscribers s
    LEFT JOIN clients c ON c.subscriber_id = s.id
    GROUP BY s.id
    ORDER BY s.id DESC
  `).all() as any[];

  // Attach server_ids and server details for each subscriber
  const result = subscribers.map((sub) => {
    const peers = db.prepare(`
      SELECT c.id, c.server_id, c.client_ip, c.enabled, s.name as server_name, s.host
      FROM clients c
      JOIN servers s ON c.server_id = s.id
      WHERE c.subscriber_id = ?
    `).all(sub.id) as any[];

    return {
      ...sub,
      server_ids: peers.map((p) => p.server_id),
      servers: peers.map((p) => ({
        id: p.server_id,
        name: p.server_name,
        host: p.host,
        client_ip: p.client_ip,
        enabled: p.enabled,
      })),
    };
  });

  res.json(result);
});

// POST /api/subscribers
subscribersRouter.post('/', async (req, res) => {
  const { name, server_ids = [] } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Имя пользователя обязательно' });
  }

  const token = 'sub_' + crypto.randomBytes(16).toString('hex');

  const subStmt = db.prepare(`
    INSERT INTO subscribers (name, token, enabled)
    VALUES (?, ?, 1)
  `);
  const subResult = subStmt.run(name.trim(), token);
  const subscriberId = Number(subResult.lastInsertRowid);

  // Generate peer on each selected server
  const affectedServers: number[] = [];

  for (const sId of server_ids) {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(sId) as any;
    if (server) {
      try {
        const keyPair = AwgService.generateKeyPair();
        const psk = AwgService.generatePresharedKey();
        const clientIp = AwgService.getNextClientIp(server.id, server.subnet);

        db.prepare(`
          INSERT INTO clients (
            server_id, subscriber_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `).run(server.id, subscriberId, `${name.trim()} (${server.name})`, clientIp, keyPair.publicKey, keyPair.privateKey, psk);

        affectedServers.push(server.id);
      } catch (err) {
        console.error(`Ошибка добавления пира на сервер #${sId}:`, err);
      }
    }
  }

  // Hot-sync peers on all affected servers
  for (const sId of affectedServers) {
    const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(sId) as any;
    if (server && server.status === 'online') {
      ProvisionService.syncPeers(sId).catch((err) =>
        console.error(`Ошибка синхронизации сервера #${sId}:`, err)
      );
    }
  }

  const newSub = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId) as any;
  res.status(201).json({ ...newSub, server_ids: affectedServers });
});

// PUT /api/subscribers/:id
subscribersRouter.put('/:id', async (req, res) => {
  const subscriberId = Number(req.params.id);
  const subscriber = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId) as any;
  if (!subscriber) return res.status(404).json({ error: 'Пользователь не найден' });

  const { name, enabled, server_ids } = req.body;

  db.prepare(`
    UPDATE subscribers SET
      name = COALESCE(?, name),
      enabled = COALESCE(?, enabled)
    WHERE id = ?
  `).run(name ?? null, enabled ?? null, subscriberId);

  const affectedServers: Set<number> = new Set();

  // If enabled changed, update enabled state on all clients of this subscriber
  if (enabled !== undefined) {
    db.prepare('UPDATE clients SET enabled = ? WHERE subscriber_id = ?').run(enabled ? 1 : 0, subscriberId);
    const existingPeers = db.prepare('SELECT server_id FROM clients WHERE subscriber_id = ?').all(subscriberId) as any[];
    existingPeers.forEach((p) => affectedServers.add(p.server_id));
  }

  // Update server node access if server_ids passed
  if (Array.isArray(server_ids)) {
    const existingPeers = db.prepare('SELECT server_id FROM clients WHERE subscriber_id = ?').all(subscriberId) as any[];
    const currentServerIds = new Set(existingPeers.map((p) => p.server_id));
    const targetServerIds = new Set(server_ids);

    // Servers to remove
    for (const curId of currentServerIds) {
      if (!targetServerIds.has(curId)) {
        db.prepare('DELETE FROM clients WHERE subscriber_id = ? AND server_id = ?').run(subscriberId, curId);
        affectedServers.add(curId);
      }
    }

    // Servers to add
    for (const tgtId of targetServerIds) {
      if (!currentServerIds.has(tgtId)) {
        const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(tgtId) as any;
        if (server) {
          try {
            const keyPair = AwgService.generateKeyPair();
            const psk = AwgService.generatePresharedKey();
            const clientIp = AwgService.getNextClientIp(server.id, server.subnet);

            db.prepare(`
              INSERT INTO clients (
                server_id, subscriber_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(server.id, subscriberId, `${subscriber.name} (${server.name})`, clientIp, keyPair.publicKey, keyPair.privateKey, psk, subscriber.enabled);

            affectedServers.add(server.id);
          } catch (err) {
            console.error(`Ошибка добавления пира на сервер #${tgtId}:`, err);
          }
        }
      }
    }
  }

  // Hot-sync peers on all affected servers
  for (const sId of affectedServers) {
    const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(sId) as any;
    if (server && server.status === 'online') {
      ProvisionService.syncPeers(sId).catch((err) =>
        console.error(`Ошибка синхронизации сервера #${sId}:`, err)
      );
    }
  }

  const updated = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId);
  res.json(updated);
});

// DELETE /api/subscribers/:id
subscribersRouter.delete('/:id', async (req, res) => {
  const subscriberId = Number(req.params.id);
  const subscriber = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId) as any;
  if (!subscriber) return res.status(404).json({ error: 'Пользователь не найден' });

  // Find all affected server IDs before deleting
  const peers = db.prepare('SELECT server_id FROM clients WHERE subscriber_id = ?').all(subscriberId) as any[];
  const affectedServers = [...new Set(peers.map((p) => p.server_id))];

  // Delete subscriber (cascades to clients)
  db.prepare('DELETE FROM subscribers WHERE id = ?').run(subscriberId);

  // Hot-sync servers to remove peer
  for (const sId of affectedServers) {
    const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(sId) as any;
    if (server && server.status === 'online') {
      ProvisionService.syncPeers(sId).catch((err) =>
        console.error(`Ошибка синхронизации сервера #${sId}:`, err)
      );
    }
  }

  res.json({ success: true, message: 'Пользователь и его пиры удалены' });
});

// POST /api/subscribers/:id/reset-token
subscribersRouter.post('/:id/reset-token', (req, res) => {
  const subscriberId = Number(req.params.id);
  const subscriber = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(subscriberId) as any;
  if (!subscriber) return res.status(404).json({ error: 'Пользователь не найден' });

  const newToken = 'sub_' + crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE subscribers SET token = ? WHERE id = ?').run(newToken, subscriberId);

  res.json({ success: true, token: newToken });
});
