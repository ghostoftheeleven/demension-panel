import { Router } from 'express';
import { EventService, EventLevel } from '../services/event.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { HttpError } from '../utils/http.js';

export const eventsRouter = Router();
eventsRouter.use(requireAuth);

eventsRouter.get('/', (req, res) => {
  const level = req.query.level;
  if (level !== undefined && level !== '' && !['info', 'warning', 'error'].includes(String(level))) {
    throw new HttpError(400, 'Некорректный уровень события');
  }
  const numberQuery = (value: unknown, fallback: number) => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new HttpError(400, 'Некорректные параметры списка');
    return parsed;
  };
  res.json(EventService.list({
    level: level ? String(level) as EventLevel : undefined,
    limit: numberQuery(req.query.limit, 50),
    offset: numberQuery(req.query.offset, 0),
  }));
});
