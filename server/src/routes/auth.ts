import { Router } from 'express';
import { AuthService, MIN_PASSWORD_LENGTH } from '../services/auth.service.js';
import { requireAuth, AuthenticatedRequest, getBearerToken } from '../middleware/auth.middleware.js';
import { loginIpLimiter, loginUserLimiter } from '../middleware/rate-limit.js';

export const authRouter = Router();

// POST /api/auth/login
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  const ipKey = req.ip || 'unknown';
  const userKey = username.toLowerCase();
  const blockedMs = Math.max(loginIpLimiter.blockedFor(ipKey), loginUserLimiter.blockedFor(userKey));
  if (blockedMs > 0) {
    res.setHeader('Retry-After', Math.ceil(blockedMs / 1000));
    return res.status(429).json({
      error: `Слишком много неудачных попыток. Повторите через ${Math.ceil(blockedMs / 60000)} мин.`,
    });
  }

  const result = AuthService.login(username, password);
  if (!result) {
    loginIpLimiter.registerFailure(ipKey);
    loginUserLimiter.registerFailure(userKey);
    console.warn(`[AUTH] Неудачная попытка входа для "${username}" с ${ipKey}`);
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }

  loginIpLimiter.reset(ipKey);
  loginUserLimiter.reset(userKey);
  res.json(result);
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout
authRouter.post('/logout', requireAuth, (req: AuthenticatedRequest, res) => {
  const token = getBearerToken(req);
  if (token) AuthService.logout(token);
  res.json({ success: true, message: 'Выход выполнен' });
});

// POST /api/auth/change-password
authRouter.post('/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
  const { oldPassword, newPassword } = req.body ?? {};
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Старый и новый пароли обязательны' });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Новый пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов` });
  }

  const token = AuthService.changePassword(req.user!.id, oldPassword, newPassword);
  if (!token) {
    return res.status(400).json({ error: 'Неверный старый пароль' });
  }

  res.json({ success: true, token, message: 'Пароль успешно изменен. Остальные сессии завершены.' });
});
