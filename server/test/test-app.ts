import http from 'node:http';
import express, { Request, Response, NextFunction } from 'express';
import { authRouter } from '../src/routes/auth.js';
import { serversRouter } from '../src/routes/servers.js';
import { clientsRouter } from '../src/routes/clients.js';
import { subscribersRouter } from '../src/routes/subscribers.js';
import { subscriptionRouter } from '../src/routes/subscription.js';
import { securityRouter } from '../src/routes/security.js';
import { settingsRouter } from '../src/routes/settings.js';
import { subscriptionSettingsRouter } from '../src/routes/subscription-settings.js';
import { federationRouter } from '../src/routes/federation.js';
import { partnersRouter } from '../src/routes/partners.js';
import { remotePanelsRouter } from '../src/routes/remote-panels.js';
import { requireAuth } from '../src/middleware/auth.middleware.js';
import { HttpError } from '../src/utils/http.js';

export function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Public subscription
  app.use('/sub', subscriptionRouter);

  // Federation API
  app.use('/api/federation/v1', federationRouter);

  // Auth routes
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

  // Error handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(500).json({ error: err?.message || 'Internal Server Error' });
  });

  return app;
}

export async function startTestServer() {
  const app = createTestApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const request = async (path: string, options: RequestInit = {}) => {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    return fetch(url, options);
  };

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { server, baseUrl, request, close };
}
