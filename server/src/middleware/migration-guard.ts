import type { NextFunction, Request, Response } from 'express';
import { MigrationService } from '../services/migration.service.js';

/**
 * Пока панель переносится на другой сервер, её данные уже скопированы: всё, что изменили бы после снимка, потерялось бы.
 * Подключается к /api. exporting — записи запрещены (423), migrated — панель заморожена (410), кроме /api/health.
 */
export function migrationGuard(req: Request, res: Response, next: NextFunction) {
  const state = MigrationService.getState();
  if (state === 'idle' || state === 'prepared') return next();

  if (state === 'exporting') {
    const readOnly = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    // Отмена и завершение переноса, вход и выход — единственные записи, которые не теряются
    const allowed = req.path.startsWith('/migration') || req.path === '/auth/login' || req.path === '/auth/logout';
    if (readOnly || allowed) return next();
    return res.status(423).json({
      error: 'Идёт перенос панели на другой сервер: изменения сейчас не сохраняются. Завершите перенос или отмените его в разделе «Безопасность».',
      migration: 'exporting',
    });
  }

  if (req.path === '/health') return next();
  const { newUrl } = MigrationService.getStatus();
  res.status(410).json({
    error: `Панель перенесена на другой сервер${newUrl ? `: ${newUrl}` : ''}. На этом сервере она отключена.`,
    migrated: true,
    newUrl,
  });
}

/**
 * Ссылки подписок перенесённой панели ведут на новую: пока старый сервер включён, приложения пользователей
 * (по 308 с тем же путём) продолжают получать подписку, даже если адрес панели изменился.
 */
export function subscriptionFreeze(req: Request, res: Response, next: NextFunction) {
  if (MigrationService.getState() !== 'migrated') return next();
  const { newUrl } = MigrationService.getStatus();
  if (!newUrl) return res.status(410).type('text/plain').send('Panel has been moved to another server');
  res.redirect(308, newUrl + req.originalUrl);
}
