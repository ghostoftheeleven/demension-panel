import { Router } from 'express';
import { TelegramService } from '../services/telegram.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler, HttpError } from '../utils/http.js';
import { normalizeBotToken, normalizeChatId, validateBotToken, validateChatId } from '../utils/telegram.js';

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
  const chatId = normalizeChatId(body.chat_id);
  if (chatId) {
    if (!validateChatId(chatId)) {
      if (/^[A-Za-z0-9_]{4,32}$/.test(chatId)) {
        throw new HttpError(400, 'Для каналов укажите @имя_канала, для пользователей — числовой ID из @userinfobot');
      }
      throw new HttpError(400, 'ID чата должен содержать только цифры, знак минуса или @имя_канала');
    }
  }
  if (body.bot_token !== undefined && typeof body.bot_token !== 'string') throw new HttpError(400, 'Некорректный токен бота');
  let token: string | undefined;
  if (body.bot_token !== undefined) {
    const normalized = normalizeBotToken(body.bot_token);
    if (normalized) {
      if (!validateBotToken(normalized)) throw new HttpError(400, 'Некорректный токен бота');
      token = normalized;
    } else {
      token = '';
    }
  }
  res.json({ settings: TelegramService.saveSettings({ enabled: body.enabled, chat_id: chatId, bot_token: token, notify_info: body.notify_info }) });
});

telegramRouter.post('/test', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  let botToken: string | undefined;
  let chatId: string | undefined;

  if (body.bot_token !== undefined) {
    if (typeof body.bot_token !== 'string') throw new HttpError(400, 'Некорректный токен бота');
    const normalized = normalizeBotToken(body.bot_token);
    if (normalized) {
      if (!validateBotToken(normalized)) throw new HttpError(400, 'Некорректный токен бота');
      botToken = normalized;
    }
  }

  if (body.chat_id !== undefined) {
    if (typeof body.chat_id !== 'string') throw new HttpError(400, 'Некорректный ID чата');
    const normalized = normalizeChatId(body.chat_id);
    if (normalized) {
      if (!validateChatId(normalized)) {
        if (/^[A-Za-z0-9_]{4,32}$/.test(normalized)) {
          throw new HttpError(400, 'Для каналов укажите @имя_канала, для пользователей — числовой ID из @userinfobot');
        }
        throw new HttpError(400, 'ID чата должен содержать только цифры, знак минуса или @имя_канала');
      }
      chatId = normalized;
    }
  }

  res.json(await TelegramService.test({ bot_token: botToken, chat_id: chatId }));
}));

telegramRouter.post('/detect-chat', asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  let botToken: string | undefined;

  if (body.bot_token !== undefined) {
    if (typeof body.bot_token !== 'string') throw new HttpError(400, 'Некорректный токен бота');
    const normalized = normalizeBotToken(body.bot_token);
    if (normalized) {
      if (!validateBotToken(normalized)) throw new HttpError(400, 'Некорректный токен бота');
      botToken = normalized;
    }
  }

  res.json(await TelegramService.detectChatId(botToken));
}));
