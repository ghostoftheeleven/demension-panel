import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import type { TLSSocket } from 'node:tls';
import express, { NextFunction, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { initDatabase, db } from './db/index.js';
import { AuthService } from './services/auth.service.js';
import { requireAuth } from './middleware/auth.middleware.js';
import { loginIpLimiter, loginUserLimiter } from './middleware/rate-limit.js';
import { authRouter } from './routes/auth.js';
import { serversRouter } from './routes/servers.js';
import { clientsRouter } from './routes/clients.js';
import { subscribersRouter } from './routes/subscribers.js';
import { subscriptionRouter } from './routes/subscription.js';
import { securityRouter } from './routes/security.js';
import { settingsRouter } from './routes/settings.js';
import { subscriptionSettingsRouter } from './routes/subscription-settings.js';
import { federationRouter, cleanupFederationLimits } from './routes/federation.js';
import { partnersRouter } from './routes/partners.js';
import { remotePanelsRouter } from './routes/remote-panels.js';
import { PartnerService } from './services/partner.service.js';
import { FederationClient } from './services/federation-client.service.js';
import { ProvisionService } from './services/provision.service.js';
import { SubscriptionService } from './services/subscription.service.js';
import { SslService, http01Challenges } from './services/ssl.service.js';
import { HttpError } from './utils/http.js';

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL?] Необработанное отклонение промиса:', reason);
});

// Initialize SQLite database
initDatabase();

// Ensure initial admin exists (пароль никогда не пишется в лог, кроме сгенерированного один раз)
AuthService.ensureDefaultAdmin(process.env.PANEL_USER, process.env.PANEL_PASSWORD);

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

const isEncrypted = (req: Request) => Boolean((req.socket as TLSSocket).encrypted);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isEncrypted(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Let's Encrypt HTTP-01 challenge responder (когда панель сама слушает 80 порт)
app.get('/.well-known/acme-challenge/:token', (req, res) => {
  const keyAuth = http01Challenges.get(req.params.token);
  if (keyAuth) {
    res.type('text/plain').send(keyAuth);
  } else {
    res.status(404).send('Challenge not found');
  }
});

// Public Subscription Endpoint — доступен и по HTTP, чтобы выданные ранее ссылки не ломались после включения HTTPS
app.use('/sub', subscriptionRouter);

// При включённом HTTPS остальные запросы по обычному HTTP перенаправляются на HTTPS
app.use((req, res, next) => {
  if (!SslService.isActive() || isEncrypted(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Панель доступна только по HTTPS', https: true });
  }
  res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
});

app.use(express.json({ limit: '1mb' }));

// Public Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    https: SslService.isActive(),
    timestamp: new Date().toISOString(),
  });
});

// API для панелей партнёров (авторизация по партнёрскому токену, только HTTPS)
app.use('/api/federation/v1', federationRouter);

// Authentication routes (login, me, logout, change-password)
app.use('/api/auth', authRouter);

// Protected Admin API Routes
app.use('/api/servers', requireAuth, serversRouter);
app.use('/api/subscribers', subscribersRouter);
app.use('/api/security', securityRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/subscription-settings', subscriptionSettingsRouter);
app.use('/api/partners', partnersRouter);
app.use('/api/remote-panels', remotePanelsRouter);
app.use('/api', requireAuth, clientsRouter);

// Unknown API routes must not fall through to the SPA
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Метод API не найден' });
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

// JSON error handler (в т.ч. некорректный JSON в теле запроса)
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Слишком большой запрос' });
  }
  console.error(`[HTTP] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ==============================================================================
// HTTP и HTTPS на одном порту: первый байт 0x16 — TLS ClientHello
// ==============================================================================

const httpServer = http.createServer(app);
let httpsServer: https.Server | null = null;

function loadTls(): void {
  if (!SslService.hasCertificate()) return;
  try {
    const { cert, key } = SslService.readCertificate();
    if (httpsServer) {
      httpsServer.setSecureContext({ cert, key });
    } else {
      httpsServer = https.createServer({ cert, key }, app);
      httpsServer.on('upgrade', handleUpgrade);
      httpsServer.on('tlsClientError', () => {});
    }
    console.log('🔒 TLS-сертификат загружен');
  } catch (err) {
    console.error('Ошибка загрузки SSL сертификатов, HTTPS недоступен:', err);
  }
}

SslService.onCertificateChanged(loadTls);

const mainServer = net.createServer((socket) => {
  socket.on('error', () => socket.destroy());
  // Соединение, не приславшее ни байта, закрывается (дальше таймауты задают HTTP/HTTPS-серверы)
  socket.setTimeout(30000, () => socket.destroy());
  socket.once('data', (chunk) => {
    socket.setTimeout(0);
    socket.pause();
    socket.unshift(chunk);
    const target = chunk[0] === 0x16 && httpsServer && SslService.isActive() ? httpsServer : httpServer;
    target.emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
});

// ==============================================================================
// WebSocket: живые логи установки. Первое сообщение — {type: 'auth', token}.
// ==============================================================================

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
wss.on('error', (err) => console.error('[WS] Ошибка сервера:', err));

function handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  const pathname = (req.url || '').split('?')[0];
  const encrypted = Boolean((socket as TLSSocket).encrypted);
  if (pathname !== '/ws' || (SslService.isActive() && !encrypted)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}
httpServer.on('upgrade', handleUpgrade);

const send = (ws: WebSocket, payload: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

wss.on('connection', (ws: WebSocket) => {
  let user: { id: number; username: string } | null = null;
  // Некорректный фрейм не должен ронять процесс
  ws.on('error', () => ws.terminate());
  const authTimer = setTimeout(() => {
    if (!user) ws.close(4401, 'auth timeout');
  }, 10000);
  ws.on('close', () => clearTimeout(authTimer));

  ws.on('message', async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Некорректное сообщение' });
    }

    if (!user) {
      if (msg?.type === 'auth' && typeof msg.token === 'string') {
        user = AuthService.validateSession(msg.token);
      }
      if (!user) {
        send(ws, { type: 'error', message: 'Необходима авторизация' });
        return ws.close(4401, 'unauthorized');
      }
      clearTimeout(authTimer);
      return send(ws, { type: 'auth_ok' });
    }

    try {
      if (msg.type === 'start_install' && Number.isInteger(msg.serverId)) {
        send(ws, { type: 'log', data: `Запуск задачи установки для сервера #${msg.serverId}...\r\n` });
        const result = await ProvisionService.installServer(msg.serverId, (logChunk) => send(ws, { type: 'log', data: logChunk }));
        send(ws, { type: 'install_finished', result });
      }
    } catch (err: any) {
      send(ws, { type: 'error', message: err.message });
    }
  });
});

// ==============================================================================
// Фоновые задачи
// ==============================================================================

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await fn(item).catch(() => {});
    }
  });
  await Promise.all(workers);
}

// Опрос нод: статистика, восстановление статуса, досинхронизация. Следующий цикл — после завершения текущего.
async function statsLoop() {
  try {
    const servers = db.prepare("SELECT id FROM servers WHERE status IN ('online', 'offline', 'error')").all() as { id: number }[];
    await mapLimit(servers, 5, (s) => ProvisionService.fetchServerStats(s.id));
    SubscriptionService.refreshSuspension();
    PartnerService.refreshSuspension();
  } catch (err) {
    console.error('[STATS] Ошибка фонового опроса:', err);
  } finally {
    setTimeout(statsLoop, 30000);
  }
}
setTimeout(statsLoop, 5000);

// Синхронизация нод и клиентов на панелях партнёров
async function federationLoop() {
  try {
    await FederationClient.syncAll();
  } catch (err) {
    console.error('[FEDERATION] Ошибка синхронизации:', err);
  } finally {
    setTimeout(federationLoop, 60000);
  }
}
setTimeout(federationLoop, 10000);

setInterval(() => {
  cleanupFederationLimits();
  AuthService.cleanupExpiredSessions();
  loginIpLimiter.cleanup();
  loginUserLimiter.cleanup();
}, 60 * 60 * 1000);

const renew = () => SslService.renewIfNeeded().catch((err) => console.error('[SSL]', err));
setTimeout(renew, 60 * 1000);
setInterval(renew, 12 * 60 * 60 * 1000);

loadTls();

const PORT = Number(process.env.PORT) || 3001;
mainServer.listen(PORT, () => {
  console.log(`🚀 Demension Panel Server running on port ${PORT} (${SslService.isActive() ? 'HTTPS + HTTP для подписок' : 'HTTP'})`);
});
