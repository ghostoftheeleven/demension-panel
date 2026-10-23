import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { initDatabase, db } from './db/index.js';
import { AuthService } from './services/auth.service.js';
import { requireAuth } from './middleware/auth.middleware.js';
import { authRouter } from './routes/auth.js';
import { serversRouter } from './routes/servers.js';
import { clientsRouter } from './routes/clients.js';
import { subscribersRouter } from './routes/subscribers.js';
import { subscriptionRouter } from './routes/subscription.js';
import { securityRouter } from './routes/security.js';
import { ProvisionService } from './services/provision.service.js';
import { certPath, keyPath, http01Challenges } from './services/ssl.service.js';

// Initialize SQLite database
initDatabase();

// Ensure initial admin exists
const initialUser = process.env.PANEL_USER || 'admin';
const initialPass = process.env.PANEL_PASSWORD || 'admin';
AuthService.ensureDefaultAdmin(initialUser, initialPass);

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Let's Encrypt HTTP-01 challenge responder
app.get('/.well-known/acme-challenge/:token', (req, res) => {
  const token = req.params.token;
  const keyAuth = http01Challenges.get(token);
  if (keyAuth) {
    res.setHeader('Content-Type', 'text/plain');
    res.send(keyAuth);
  } else {
    res.status(404).send('Challenge not found');
  }
});

// Public Subscription Endpoint (for HAPP, Incy, etc.)
app.use('/sub', subscriptionRouter);

// Public Health Check
app.get('/api/health', (req, res) => {
  const sslRow = db.prepare("SELECT value FROM settings WHERE key = 'ssl_enabled'").get() as any;
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    https: sslRow?.value === '1',
    timestamp: new Date().toISOString(),
  });
});

// Authentication routes (login, me, logout, change-password)
app.use('/api/auth', authRouter);

// Protected Admin API Routes
app.use('/api/servers', requireAuth, serversRouter);
app.use('/api/subscribers', subscribersRouter);
app.use('/api/security', securityRouter);
app.use('/api', requireAuth, clientsRouter);

// Serve frontend if built
const clientDistCandidates = [
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(process.cwd(), '../client/dist'),
];
const clientDistPath = clientDistCandidates.find((p) => fs.existsSync(p));
if (clientDistPath) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Check if SSL is enabled and certificates exist
const sslRow = db.prepare("SELECT value FROM settings WHERE key = 'ssl_enabled'").get() as any;
const isSslEnabled = sslRow?.value === '1' && fs.existsSync(certPath) && fs.existsSync(keyPath);

let server: http.Server | https.Server;

if (isSslEnabled) {
  try {
    server = https.createServer(
      {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      },
      app
    );
    console.log('🔒 HTTPS активирован с сертификатом из data/ssl/');
  } catch (err) {
    console.error('Ошибка загрузки SSL сертификатов, переключение на HTTP:', err);
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server, path: '/ws' });

// WebSocket handling for real-time install logs
wss.on('connection', (ws: WebSocket) => {
  ws.on('message', async (data: string) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'start_install' && msg.serverId) {
        ws.send(JSON.stringify({ type: 'log', data: `Запуск задачи установки для сервера #${msg.serverId}...\r\n` }));

        const result = await ProvisionService.installServer(msg.serverId, (logChunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'log', data: logChunk }));
          }
        });

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'install_finished', result }));
        }
      }
    } catch (err: any) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    }
  });
});

// Periodic background stats collector (every 30 seconds)
setInterval(async () => {
  try {
    const servers = db.prepare("SELECT id FROM servers WHERE status = 'online'").all() as { id: number }[];
    for (const s of servers) {
      await ProvisionService.fetchServerStats(s.id).catch(() => {});
    }
  } catch (err) {
    // Silent background poll
  }
}, 30000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  const protocol = isSslEnabled ? 'https' : 'http';
  const wsProtocol = isSslEnabled ? 'wss' : 'ws';
  console.log(`🚀 Demension Panel Server running on ${protocol}://localhost:${PORT}`);
  console.log(`📡 WebSocket ready on ${wsProtocol}://localhost:${PORT}/ws`);
  console.log(`🔑 Default admin credentials: ${initialUser} / ${initialPass}`);
});
