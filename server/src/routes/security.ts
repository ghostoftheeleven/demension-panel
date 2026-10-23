import { Router } from 'express';
import { SslService } from '../services/ssl.service.js';
import { Fail2banService } from '../services/fail2ban.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';

export const securityRouter = Router();

securityRouter.use(requireAuth);

// ==============================================================================
// SSL / HTTPS Routes
// ==============================================================================

// GET SSL status
securityRouter.get('/ssl', (req, res) => {
  const status = SslService.getStatus();
  res.json(status);
});

// Verify Cloudflare Token
securityRouter.post('/ssl/verify-cf', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Токен Cloudflare обязателен' });

  const result = await SslService.verifyCloudflareToken(token);
  res.json(result);
});

// Get Cloudflare Zones
securityRouter.post('/ssl/cf-zones', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Токен Cloudflare обязателен' });

  try {
    const zones = await SslService.getCloudflareZones(token);
    res.json(zones);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Issue Let's Encrypt via Cloudflare DNS-01
securityRouter.post('/ssl/issue-cf', async (req, res) => {
  const { domain, email, token, createARecord = true } = req.body;
  if (!domain || !email || !token) {
    return res.status(400).json({ error: 'Домен, email и токен Cloudflare обязательны' });
  }

  try {
    const result = await SslService.issueLetsEncryptCloudflare(domain, email, token, createARecord);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Issue Let's Encrypt via HTTP-01
securityRouter.post('/ssl/issue-http', async (req, res) => {
  const { domain, email } = req.body;
  if (!domain || !email) {
    return res.status(400).json({ error: 'Домен и email обязательны' });
  }

  try {
    const result = await SslService.issueLetsEncryptHttp(domain, email);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Issue Self-Signed IP Certificate
securityRouter.post('/ssl/issue-ip', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP адрес или домен обязателен' });

  try {
    const result = await SslService.generateSelfSignedIpCert(ip);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Save Custom Certificate
securityRouter.post('/ssl/custom', (req, res) => {
  const { cert, key, domain } = req.body;
  if (!cert || !key) {
    return res.status(400).json({ error: 'Сертификат (fullchain) и ключ обязательны' });
  }

  try {
    SslService.saveCustomCertificate(cert, key, domain);
    res.json({ success: true, message: 'Сертификат успешно сохранен' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle SSL
securityRouter.post('/ssl/toggle', (req, res) => {
  const { enabled } = req.body;
  try {
    SslService.toggleSsl(Boolean(enabled));
    res.json({ success: true, enabled: Boolean(enabled) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==============================================================================
// Fail2ban Routes
// ==============================================================================

// GET Fail2ban status
securityRouter.get('/fail2ban', async (req, res) => {
  const status = await Fail2banService.getStatus();
  res.json(status);
});

// Unban IP
securityRouter.post('/fail2ban/unban', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP адрес обязателен' });

  try {
    const result = await Fail2banService.unbanIp(ip);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Ban IP
securityRouter.post('/fail2ban/ban', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP адрес обязателен' });

  try {
    const result = await Fail2banService.banIp(ip);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Setup local Fail2ban
securityRouter.post('/fail2ban/setup', async (req, res) => {
  try {
    const result = await Fail2banService.setupLocal();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
