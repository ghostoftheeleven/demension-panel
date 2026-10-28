import { Router } from 'express';
import { TelegramService } from '../services/telegram.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, HttpError } from '../utils/http.js';

export const telegramRouter = Router();
telegramRouter.use(requireAuth);

telegramRouter.get('/', (req, res) => {
  res.json({ settings: TelegramService.getSettings() });
});

telegramRouter.put('/', (req, res) => {
  const body = req.body ?? {};
  if (typeof body.enabled !== 'boolean' || typeof body.notify_info !== 'boolean' || typeof body.chat_id !== 'string') {
    throw new HttpError(400, 'Некорректные настройки Telegram');
  }
  const chatId = body.chat_id.trim();
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) throw new HttpError(400, 'ID чата должен содержать только цифры и знак минуса');
  if (body.bot_token !== undefined && typeof body.bot_token !== 'string') throw new HttpError(400, 'Некорректный токен бота');
  const token = body.bot_token?.trim();
  if (token && !/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Некорректный токен бота');
  res.json({ settings: TelegramService.saveSettings({ enabled: body.enabled, chat_id: chatId, bot_token: token, notify_info: body.notify_info }) });
});

telegramRouter.post('/test', asyncHandler(async (req, res) => {
  res.json(await TelegramService.test());
}));
