import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service.js';

export interface AuthenticatedRequest extends Request {
  user?: { id: number; username: string };
}

export function getBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return undefined;
}

// Токен принимается только из заголовка Authorization: в URL он утекает в историю браузера и логи прокси
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const user = AuthService.validateSession(token);
  if (!user) {
    return res.status(401).json({ error: 'Сессия истекла или недействительна' });
  }

  req.user = user;
  next();
}
