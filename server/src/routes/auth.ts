import { Router } from 'express';
import { AuthService, MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from '../services/auth.service.js';
import { requireAuth, AuthenticatedRequest, getBearerToken } from '../middleware/auth.middleware.js';
import { loginIpLimiter, loginUserLimiter, reauthLimiter } from '../middleware/rate-limit.js';
import { HttpError } from '../utils/http.js';

export const authRouter = Router();

/**
 * Подтверждение паролем для смены учётных данных: неверные попытки ограничены (429 после 5 за 15 минут)
 */
function assertReauthAllowed(adminId: number): string {
  const key = `admin:${adminId}`;
  const blockedMs = reauthLimiter.blockedFor(key);
  if (blockedMs > 0) throw new HttpError(429, `Слишком много неверных паролей. Повторите через ${Math.ceil(blockedMs / 60000)} мин.`);
  return key;
}

// POST /api/auth/login
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }

  const ipKey = req.ip || 'unknown';
  const userKey = username.toLowerCase();
  // Блокировка по логину защищает от перебора с множества адресов, но не должна закрывать вход самому администратору:
  // с IP, откуда он уже входил, действует только лимит по IP
  const userBlockedMs = AuthService.isKnownLoginIp(ipKey) ? 0 : loginUserLimiter.blockedFor(userKey);
  const blockedMs = Math.max(loginIpLimiter.blockedFor(ipKey), userBlockedMs);
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
    // Логин задаёт посторонний: JSON.stringify экранирует переводы строк и не даёт подделать записи журнала
    console.warn(`[AUTH] Неудачная попытка входа для ${JSON.stringify(username.slice(0, 64))} с ${ipKey}`);
    return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
  }

  loginIpLimiter.reset(ipKey);
  loginUserLimiter.reset(userKey);
  if (ipKey !== 'unknown') AuthService.rememberLoginIp(ipKey);
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

  const limiterKey = assertReauthAllowed(req.user!.id);
  const token = AuthService.changePassword(req.user!.id, oldPassword, newPassword);
  if (!token) {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный старый пароль' });
  }
  reauthLimiter.reset(limiterKey);

  res.json({ success: true, token, message: 'Пароль успешно изменен. Остальные сессии завершены.' });
});

// POST /api/auth/change-username — смена логина администратора по текущему паролю
authRouter.post('/change-username', requireAuth, (req: AuthenticatedRequest, res) => {
  const { password, newUsername } = req.body ?? {};
  if (typeof password !== 'string' || typeof newUsername !== 'string' || !password || !newUsername.trim()) {
    return res.status(400).json({ error: 'Текущий пароль и новый логин обязательны' });
  }
  const username = newUsername.trim();
  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: 'Логин: от 1 до 64 символов — латинские буквы, цифры и . _ @ -' });
  }
  if (username === req.user!.username) {
    return res.status(400).json({ error: 'Новый логин совпадает с текущим' });
  }

  const limiterKey = assertReauthAllowed(req.user!.id);
  const result = AuthService.changeUsername(req.user!.id, password, username);
  if (result === 'wrong_password') {
    reauthLimiter.registerFailure(limiterKey);
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  reauthLimiter.reset(limiterKey);
  if (result === 'taken') return res.status(409).json({ error: 'Такой логин уже занят' });

  console.log(`[AUTH] Логин администратора изменён с ${JSON.stringify(req.user!.username)} на ${JSON.stringify(result.username)}`);
  res.json({
    success: true,
    token: result.token,
    user: { id: req.user!.id, username: result.username },
    message: 'Логин изменён. Остальные сессии завершены.',
  });
});
