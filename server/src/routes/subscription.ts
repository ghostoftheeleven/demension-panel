import { Router } from 'express';
import { db } from '../db/index.js';

export const subscriptionRouter = Router();

// GET /sub/:token - Public subscription URL for HAPP, Incy and other VPN/proxy clients
subscriptionRouter.get('/:token', (req, res) => {
  const { token } = req.params;
  const format = req.query.format as string | undefined;

  const subscriber = db.prepare('SELECT * FROM subscribers WHERE token = ?').get(token) as any;
  if (!subscriber) {
    return res.status(404).send('Subscription not found');
  }

  if (!subscriber.enabled) {
    return res.status(403).send('Subscription is disabled');
  }

  // Get all active peers on online servers for this subscriber
  const peers = db.prepare(`
    SELECT 
      c.id, c.client_ip, c.client_private_key, c.client_public_key, c.preshared_key, c.total_rx, c.total_tx,
      s.id as server_id, s.name as server_name, s.host, s.awg_port, s.server_public_key,
      s.jc, s.jmin, s.jmax, s.s1, s.s2, s.h1, s.h2, s.h3, s.h4
    FROM clients c
    JOIN servers s ON c.server_id = s.id
    WHERE c.subscriber_id = ? AND c.enabled = 1 AND s.status = 'online'
  `).all(subscriber.id) as any[];

  // Calculate total traffic for Userinfo header
  const totalRx = peers.reduce((acc, p) => acc + (p.total_rx || 0), 0);
  const totalTx = peers.reduce((acc, p) => acc + (p.total_tx || 0), 0);

  // Set subscription headers consumed by HAPP, Incy, Streisand, etc.
  res.setHeader('Subscription-Userinfo', `upload=${totalTx}; download=${totalRx}; total=0; expire=0`);
  res.setHeader('Profile-Update-Interval', '12'); // Auto-update interval in hours
  res.setHeader('Profile-Title', `Demension - ${subscriber.name}`);
  res.setHeader('Content-Disposition', `inline; filename="${subscriber.name}-sub.txt"`);

  // Format 1: Sing-Box JSON format (if ?format=singbox)
  if (format === 'singbox') {
    const outbounds = peers.map((p) => ({
      type: 'wireguard',
      tag: p.server_name,
      server: p.host,
      server_port: p.awg_port,
      local_address: [`${p.client_ip}/32`],
      private_key: p.client_private_key,
      peer_public_key: p.server_public_key,
      pre_shared_key: p.preshared_key,
      reserved: [0, 0, 0],
      mtu: 1280,
    }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.json({ outbounds });
  }

  // Format 2: Standard Base64-encoded URI links list (compatible with HAPP, Incy, etc.)
  const links: string[] = [];

  for (const p of peers) {
    const tag = encodeURIComponent(`${p.server_name} (AmneziaWG)`);
    const psk = encodeURIComponent(p.preshared_key || '');
    const privKey = encodeURIComponent(p.client_private_key);
    const pubKey = encodeURIComponent(p.server_public_key);

    // Standard AmneziaWG and WireGuard URI with all obfuscation parameters
    const awgUri = `awg://${privKey}@${p.host}:${p.awg_port}?address=${p.client_ip}%2F32&publickey=${pubKey}&presharedkey=${psk}&dns=1.1.1.1%2C8.8.8.8&mtu=1280&jc=${p.jc}&jmin=${p.jmin}&jmax=${p.jmax}&s1=${p.s1}&s2=${p.s2}&h1=${p.h1}&h2=${p.h2}&h3=${p.h3}&h4=${p.h4}#${tag}`;
    const wgUri = `wireguard://${privKey}@${p.host}:${p.awg_port}?address=${p.client_ip}%2F32&publickey=${pubKey}&presharedkey=${psk}&dns=1.1.1.1%2C8.8.8.8&mtu=1280&jc=${p.jc}&jmin=${p.jmin}&jmax=${p.jmax}&s1=${p.s1}&s2=${p.s2}&h1=${p.h1}&h2=${p.h2}&h3=${p.h3}&h4=${p.h4}#${tag}`;

    links.push(awgUri);
    links.push(wgUri);
  }

  // Return base64 encoded list of links
  const base64Content = Buffer.from(links.join('\n')).toString('base64');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(base64Content);
});
