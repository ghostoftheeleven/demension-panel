import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { initDatabase, db } from './db/index.js';
import { serversRouter } from './routes/servers.js';
import { clientsRouter } from './routes/clients.js';
import { ProvisionService } from './services/provision.service.js';

// Initialize SQLite database
initDatabase();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/servers', serversRouter);
app.use('/api', clientsRouter);

// System health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

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

// WebSocket handling for real-time install logs and live server monitoring
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
  console.log(`🚀 Demension Panel Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready on ws://localhost:${PORT}/ws`);
});
