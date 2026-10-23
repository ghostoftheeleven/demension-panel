import { Router } from 'express';
import { AuthService } from '../services/auth.service.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware.js';

export const authRouter = Router();

// POST /api/auth/login
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  const result = AuthService.login(username, password);
  if (!result) {
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }

  res.json(result);
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout
authRouter.post('/logout', requireAuth, (req: AuthenticatedRequest, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    AuthService.logout(token);
  }
  res.json({ success: true, message: 'Выход выполнен' });
});

// POST /api/auth/change-password
authRouter.post('/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Старый и новый пароли обязательны' });
  }

  const success = AuthService.changePassword(req.user!.id, oldPassword, newPassword);
  if (!success) {
    return res.status(400).json({ error: 'Неверный старый пароль' });
  }

  res.json({ success: true, message: 'Пароль успешно изменен' });
});
