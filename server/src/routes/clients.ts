import { Router } from 'express';
import QRCode from 'qrcode';
import { db } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { ProvisionService } from '../services/provision.service.js';

export const clientsRouter = Router();

// GET all clients for server
clientsRouter.get('/servers/:serverId/clients', (req, res) => {
  const clients = db.prepare(`
    SELECT * FROM clients 
    WHERE server_id = ? 
    ORDER BY id DESC
  `).all(req.params.serverId);
  res.json(clients);
});

// POST create client for server
clientsRouter.post('/servers/:serverId/clients', async (req, res) => {
  const serverId = Number(req.params.serverId);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  if (!server) {
    return res.status(404).json({ error: 'Сервер не найден' });
  }

  const { name = `client-${Date.now().toString().slice(-4)}` } = req.body;

  try {
    const keyPair = AwgService.generateKeyPair();
    const psk = AwgService.generatePresharedKey();
    const clientIp = AwgService.getNextClientIp(serverId, server.subnet);

    const stmt = db.prepare(`
      INSERT INTO clients (
        server_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    const result = stmt.run(serverId, name, clientIp, keyPair.publicKey, keyPair.privateKey, psk);
    const newClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);

    // If server is active, live-sync peers
    if (server.status === 'online') {
      ProvisionService.syncPeers(serverId).catch((err) =>
        console.error('Ошибка фоновой синхронизации пира:', err)
      );
    }

    res.status(201).json(newClient);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update client (toggle enable, change name)
clientsRouter.put('/clients/:id', async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });

  const { name, enabled } = req.body;

  db.prepare(`
    UPDATE clients SET
      name = COALESCE(?, name),
      enabled = COALESCE(?, enabled)
    WHERE id = ?
  `).run(name ?? null, enabled ?? null, req.params.id);

  const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;

  // Sync to server
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(updated.server_id) as any;
  if (server && server.status === 'online') {
    ProvisionService.syncPeers(server.id).catch((err) =>
      console.error('Ошибка синхронизации пиров:', err)
    );
  }

  res.json(updated);
});

// DELETE client
clientsRouter.delete('/clients/:id', async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });

  const serverId = client.server_id;
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);

  // Sync to server
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  if (server && server.status === 'online') {
    ProvisionService.syncPeers(serverId).catch((err) =>
      console.error('Ошибка синхронизации пиров:', err)
    );
  }

  res.json({ success: true, message: 'Клиент удален' });
});

// GET client .conf configuration file
clientsRouter.get('/clients/:id/config', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(client.server_id) as any;
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const configText = AwgService.generateClientConfig(server, client);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${client.name}.conf"`);
  res.send(configText);
});

// GET QR code as base64 Data URL (PNG)
clientsRouter.get('/clients/:id/qrcode', async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id) as any;
  if (!client) return res.status(404).json({ error: 'Клиент не найден' });

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(client.server_id) as any;
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const configText = AwgService.generateClientConfig(server, client);

  try {
    const dataUrl = await QRCode.toDataURL(configText, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 380,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });

    res.json({
      qrcode: dataUrl,
      config: configText,
      clientName: client.name,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Ошибка генерации QR-кода' });
  }
});
