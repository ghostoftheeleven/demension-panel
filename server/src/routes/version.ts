import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { UpdateService } from '../services/update.service.js';
import { VersionService } from '../services/version.service.js';
import { asyncHandler } from '../utils/http.js';

export const versionRouter = Router();

versionRouter.use(requireAuth);

// GET /api/version — версия панели и последний релиз на GitHub (?refresh=1 — проверить сейчас, не чаще раза в минуту)
versionRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await VersionService.getInfo(req.query.refresh === '1'));
}));

// GET /api/version/update — можно ли обновить панель из интерфейса, состояние последнего обновления и журнал
versionRouter.get('/update', (req, res) => {
  res.json(UpdateService.getStatus());
});

// POST /api/version/update — обновить панель до последнего релиза; body: { version: 'vX.Y.Z' } (тот, что видел администратор)
versionRouter.post('/update', asyncHandler(async (req, res) => {
  res.json(await UpdateService.start(req.body?.version));
}));
