import { Router } from 'express';
import { db, transaction } from '../db/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { HttpError } from '../utils/http.js';
import { readSubscriptionSettings, updateSubscriptionSettings } from '../services/subscription-settings.service.js';

export const subscriptionSettingsRouter = Router();

subscriptionSettingsRouter.use(requireAuth);

const SUB_NAME_MAX = 64;

function listServers() {
  return db.prepare(`
    SELECT id, name, host, status, sub_name, sub_order
    FROM servers ORDER BY sub_order, id
  `).all();
}

// GET /api/subscription-settings — оформление подписки и отображаемые имена серверов
subscriptionSettingsRouter.get('/', (req, res) => {
  res.json({ settings: readSubscriptionSettings(), servers: listServers() });
});

// PUT /api/subscription-settings — { settings?: {...}, servers?: [{ id, sub_name, sub_order }] }
subscriptionSettingsRouter.put('/', (req, res) => {
  const body = req.body ?? {};
  const servers = body.servers;
  if (servers !== undefined && !Array.isArray(servers)) throw new HttpError(400, 'servers должен быть массивом');

  const updates = (servers ?? []).map((s: any) => {
    const id = Number(s?.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Некорректный идентификатор сервера');
    const name = String(s?.sub_name ?? '').replace(/[\r\n#]/g, ' ').trim();
    if ([...name].length > SUB_NAME_MAX) throw new HttpError(400, `Имя сервера в подписке не длиннее ${SUB_NAME_MAX} символов`);
    const order = Number(s?.sub_order ?? 0);
    if (!Number.isInteger(order) || order < 0 || order > 10000) throw new HttpError(400, 'Некорректный порядок сервера');
    return { id, name: name || null, order };
  });

  const settings = transaction(() => {
    const result = body.settings !== undefined ? updateSubscriptionSettings(body.settings ?? {}) : readSubscriptionSettings();
    const stmt = db.prepare('UPDATE servers SET sub_name = ?, sub_order = ? WHERE id = ?');
    for (const u of updates) stmt.run(u.name, u.order, u.id);
    return result;
  });

  res.json({ settings, servers: listServers() });
});
