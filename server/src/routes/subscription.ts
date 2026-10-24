import { Router } from 'express';
import { db, getSetting } from '../db/index.js';
import { AwgService } from '../services/awg.service.js';
import { SubscriptionService } from '../services/subscription.service.js';
import { base64HeaderValue, contentDisposition } from '../utils/http.js';

export const subscriptionRouter = Router();

const TITLE_MAX = 25;

function truncate(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : value;
}

/**
 * GET /sub/:token — публичная подписка для Incy и других клиентов с поддержкой AmneziaWG.
 *
 * Формат (https://docs.incy.cc/en/subscription-format/): по одной ссылке на сервер
 * `awg://<base64url(.conf)>#<имя>`, весь список дополнительно кодируется в base64.
 * `?format=json` — JSON-контейнер Incy `{type: "amneziawg", servers: [{name, config}]}`.
 */
subscriptionRouter.get('/:token', (req, res) => {
  const { token } = req.params;
  const format = typeof req.query.format === 'string' ? req.query.format : undefined;

  res.setHeader('Cache-Control', 'no-store');

  const subscriber = db.prepare('SELECT * FROM subscribers WHERE token = ?').get(token) as any;
  if (!subscriber) {
    return res.status(404).type('text/plain').send('Subscription not found');
  }

  if (!subscriber.enabled) {
    return res.status(403).type('text/plain').send('Subscription is disabled');
  }

  const usage = SubscriptionService.getUsage(subscriber.id);
  const active = !SubscriptionService.isExpired(subscriber) && !SubscriptionService.isOverLimit(subscriber, usage);
  const expire = subscriber.expire_at ? Math.floor(new Date(subscriber.expire_at).getTime() / 1000) : 0;
  const updateInterval = Number(getSetting('sub_update_interval')) || 12;
  const title = truncate(getSetting('sub_title') || subscriber.name, TITLE_MAX);

  // Set subscription headers consumed by Incy, Streisand, etc.
  res.setHeader(
    'Subscription-Userinfo',
    `upload=${usage.upload}; download=${usage.download}; total=${subscriber.traffic_limit || 0}; expire=${expire}`
  );
  res.setHeader('Profile-Update-Interval', String(updateInterval));
  res.setHeader('Profile-Title', base64HeaderValue(title));
  res.setHeader('Content-Disposition', contentDisposition('inline', `${subscriber.name}.txt`));

  // Все установленные ноды пользователя: временно недоступная нода не должна пропадать из приложения
  const peers = active
    ? (db.prepare(`
        SELECT c.*, s.name AS server_name, s.host, s.awg_port, s.server_public_key, s.preshared_key AS server_psk,
          s.jc, s.jmin, s.jmax, s.s1, s.s2, s.h1, s.h2, s.h3, s.h4
        FROM clients c
        JOIN servers s ON c.server_id = s.id
        WHERE c.subscriber_id = ? AND c.enabled = 1 AND s.status != 'uninstalled' AND s.server_public_key IS NOT NULL
        ORDER BY s.id
      `).all(subscriber.id) as any[])
    : [];

  const settings = AwgService.getClientNetworkSettings();
  const servers = peers.map((p) => {
    const server = { ...p, preshared_key: p.server_psk };
    return {
      name: p.server_name,
      config: Buffer.from(AwgService.generateClientConfig(server, p, settings)).toString('base64url'),
    };
  });

  if (format === 'json') {
    return res.json({ type: 'amneziawg', version: 1, servers });
  }

  const links = servers.map((s) => `awg://${s.config}#${encodeURIComponent(s.name)}`);
  res.type('text/plain; charset=utf-8').send(Buffer.from(links.join('\n')).toString('base64'));
});
