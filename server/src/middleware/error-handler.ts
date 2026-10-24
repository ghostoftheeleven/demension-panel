import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/http.js';

/**
 * Единый JSON-обработчик ошибок: ошибки роутов (HttpError), некорректное тело запроса, слишком большое тело и
 * прочие 4xx из Express (например, «Failed to decode param» для пути с битой %-кодировкой) — клиентские,
 * всё остальное — 500 без подробностей.
 */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
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
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'Некорректный запрос' });
  }
  console.error(`[HTTP] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}
