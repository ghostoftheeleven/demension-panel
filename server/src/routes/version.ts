import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { VersionService } from '../services/version.service.js';
import { asyncHandler } from '../utils/http.js';

export const versionRouter = Router();

versionRouter.use(requireAuth);

// GET /api/version — версия панели и последний релиз на GitHub (?refresh=1 — проверить сейчас, не чаще раза в минуту)
versionRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await VersionService.getInfo(req.query.refresh === '1'));
}));
