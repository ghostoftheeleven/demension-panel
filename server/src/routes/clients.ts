import { Router } from 'express';
import QRCode from 'qrcode';
import { db, transaction } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { ProvisionService } from '../services/provision.service.js';
import { asyncHandler, contentDisposition, HttpError, parseId } from '../utils/http.js';

export const clientsRouter = Router();

/**
 * Клиент без приватного ключа — ключ нужен только в конфиге/QR
 */
export function serializeClient(c: any) {
  if (!c) return c;
  const { client_private_key, rx_counter, tx_counter, ...rest } = c;
  return rest;
}

function getClientOr404(id: number): any {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as any;
  if (!client) throw new HttpError(404, 'Клиент не найден');
  return client;
}

function validateClientName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'Имя клиента обязательно');
  if (name.trim().length > 64) throw new HttpError(400, 'Имя клиента не длиннее 64 символов');
  return name.trim();
}

function syncIfInstalled(serverId: number): void {
  const server = db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string } | undefined;
  if (server && server.status !== 'uninstalled') {
    ProvisionService.requestSync(serverId).catch((err) => console.error(`Ошибка синхронизации сервера #${serverId}:`, err));
  }
}

// GET all clients for server
clientsRouter.get('/servers/:serverId/clients', (req, res) => {
  const clients = db.prepare(`
    SELECT * FROM clients
    WHERE server_id = ?
    ORDER BY id DESC
  `).all(parseId(req.params.serverId));
  res.json(clients.map(serializeClient));
});

// POST create client for server
clientsRouter.post('/servers/:serverId/clients', (req, res) => {
  const serverId = parseId(req.params.serverId);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
  if (!server) throw new HttpError(404, 'Сервер не найден');

  const rawName = req.body?.name;
  const name = rawName === undefined || rawName === '' ? `client-${Date.now().toString().slice(-4)}` : validateClientName(rawName);

  const keyPair = AwgService.generateKeyPair();
  const psk = AwgService.generatePresharedKey();

  const newClient = transaction(() => {
    const clientIp = AwgService.getNextClientIp(serverId, server.subnet);
    const result = db.prepare(`
      INSERT INTO clients (
        server_id, name, client_ip, client_public_key, client_private_key, preshared_key, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(serverId, name, clientIp, keyPair.publicKey, keyPair.privateKey, psk);
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
  });

  syncIfInstalled(serverId);
  res.status(201).json(serializeClient(newClient));
});

// PUT update client (toggle enable, change name)
clientsRouter.put('/clients/:id', (req, res) => {
  const id = parseId(req.params.id);
  const client = getClientOr404(id);
  const { name, enabled } = req.body ?? {};

  const newName = name === undefined ? client.name : validateClientName(name);
  const newEnabled = enabled === undefined ? client.enabled : enabled ? 1 : 0;

  db.prepare('UPDATE clients SET name = ?, enabled = ? WHERE id = ?').run(newName, newEnabled, id);
  if (newEnabled !== client.enabled) syncIfInstalled(client.server_id);

  res.json(serializeClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(id)));
});

// DELETE client
clientsRouter.delete('/clients/:id', (req, res) => {
  const id = parseId(req.params.id);
  const client = getClientOr404(id);

  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  syncIfInstalled(client.server_id);

  res.json({ success: true, message: 'Клиент удален' });
});

function loadClientWithServer(id: number) {
  const client = getClientOr404(id);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(client.server_id) as any;
  if (!server) throw new HttpError(404, 'Сервер не найден');
  return { client, server };
}

// GET client .conf configuration file
clientsRouter.get('/clients/:id/config', (req, res) => {
  const { client, server } = loadClientWithServer(parseId(req.params.id));
  const configText = AwgService.generateClientConfig(server, client);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('attachment', `${client.name}.conf`));
  res.setHeader('Cache-Control', 'no-store');
  res.send(configText);
});

// GET QR code as base64 Data URL (PNG)
clientsRouter.get('/clients/:id/qrcode', asyncHandler(async (req, res) => {
  const { client, server } = loadClientWithServer(parseId(req.params.id));
  const configText = AwgService.generateClientConfig(server, client);

  const dataUrl = await QRCode.toDataURL(configText, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 380,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    qrcode: dataUrl,
    config: configText,
    clientName: client.name,
  });
}));
