/**
 * Утилиты валидации и нормализации параметров Telegram Bot API.
 */

/**
 * Нормализует токен бота Telegram:
 * - обрезает пробелы и невидимые символы по краям
 * - вырезает токен из переданных URL вида https://api.telegram.org/bot<token>
 * - срезает префикс 'bot' перед <bot_id>:<secret>, если токен скопирован так
 */
export function normalizeBotToken(raw: string): string {
  let token = raw.trim();
  const urlMatch = token.match(/api\.telegram\.org\/bot([^\s/?#]+)/i);
  if (urlMatch) token = urlMatch[1];
  token = token.replace(/^bot(?=\d+:)/i, '');
  return token.trim();
}

/**
 * Проверяет синтаксическую корректность токена бота Telegram:
 * Формат: <bot_id>:<secret>
 * - bot_id: от 5 до 25 цифр
 * - secret: от 20 до 50 символов (латиница, цифры, _, -)
 */
export function validateBotToken(token: string): boolean {
  return /^\d{5,25}:[A-Za-z0-9_-]{20,50}$/.test(token);
}

/**
 * Нормализует ID чата или имя канала Telegram:
 * - обрезает пробелы и удаляет внутренние пробелы
 * - срезает префиксы 'id:' или 'id', если дальше следуют цифры или знак минус
 */
export function normalizeChatId(raw: string): string {
  let chatId = raw.trim().replace(/\s+/g, '');
  chatId = chatId.replace(/^id:?/i, '');
  return chatId;
}

/**
 * Проверяет валидность ID чата Telegram:
 * - числовой ID (пользователь, супергруппа/канал с минусом): от 1 до 25 цифр с опциональным минусом
 * - публичный канал/супергруппа: @username (от 4 до 32 символов)
 */
export function validateChatId(chatId: string): boolean {
  return /^-?\d{1,25}$/.test(chatId) || /^@[A-Za-z0-9_]{4,32}$/.test(chatId);
}

/**
 * Преобразует ответ Telegram Bot API в понятное пользователю сообщение на русском языке.
 */
export function formatTelegramError(description?: string, status?: number): string {
  const desc = (description ?? '').toLowerCase();

  if (desc.includes('chat not found') || desc.includes('chat_id is empty') || desc.includes('wrong chat_id')) {
    return 'Чат не найден. Откройте вашего бота в Telegram и отправьте ему команду /start (кнопка «Запустить»), чтобы разрешить боту писать вам.';
  }
  if (desc.includes("can't initiate conversation") || desc.includes('cannot initiate conversation')) {
    return 'Бот не может написать первым. Откройте вашего бота в Telegram и отправьте ему команду /start (кнопка «Запустить»).';
  }
  if (desc.includes('blocked by the user')) {
    return 'Бот заблокирован. Разблокируйте вашего бота в Telegram и отправьте ему команду /start.';
  }
  if (status === 401 || desc.includes('unauthorized')) {
    return 'Неверный токен бота. Проверьте токен, полученный от @BotFather.';
  }
  if (desc.includes('not enough rights') || desc.includes('have no rights') || desc.includes('bot is not a member')) {
    return 'У бота недостаточно прав для отправки сообщений в этот чат или канал. Добавьте бота в чат и дайте ему право писать.';
  }
  if (desc.includes('user not found')) {
    return 'Пользователь не найден. Проверьте числовой ID пользователя.';
  }
  if (description) {
    return `Telegram вернул ошибку: ${description}`;
  }
  return status ? `Telegram вернул HTTP ${status}` : 'Неизвестная ошибка Telegram';
}
