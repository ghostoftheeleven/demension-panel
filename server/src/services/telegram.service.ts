import { getSetting, setSetting } from '../db/index.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { MigrationService } from './migration.service.js';
import type { EventLevel } from './event.service.js';

export interface TelegramSettings {
  enabled: boolean;
  chat_id: string;
  bot_token_saved: boolean;
  notify_info: boolean;
}

export class TelegramService {
  static getSettings(): TelegramSettings {
    return {
      enabled: getSetting('telegram_enabled') === '1',
      chat_id: getSetting('telegram_chat_id') ?? '',
      bot_token_saved: Boolean(getSetting('telegram_bot_token')),
      notify_info: getSetting('telegram_notify_info') === '1',
    };
  }

  static saveSettings(input: { enabled: boolean; chat_id: string; bot_token?: string; notify_info: boolean }): TelegramSettings {
    setSetting('telegram_enabled', input.enabled ? '1' : '0');
    setSetting('telegram_chat_id', input.chat_id || null);
    setSetting('telegram_notify_info', input.notify_info ? '1' : '0');
    if (input.bot_token !== undefined) setSetting('telegram_bot_token', encryptSecret(input.bot_token || null));
    return this.getSettings();
  }

  static async test(settings?: { bot_token?: string; chat_id?: string }): Promise<{ success: boolean; message: string }> {
    const token = settings?.bot_token || decryptSecret(getSetting('telegram_bot_token'));
    const chatId = settings?.chat_id ?? getSetting('telegram_chat_id') ?? '';
    if (!token || !chatId) return { success: false, message: 'Укажите токен бота и ID чата' };
    return this.send(token, chatId, 'Dementia Panel: проверка уведомлений');
  }

  static async deliverEvent(event: { level: EventLevel; type: string; message: string }): Promise<void> {
    try {
      if (getSetting('telegram_enabled') !== '1') return;
      if (event.level === 'info' && getSetting('telegram_notify_info') !== '1') return;
      const token = decryptSecret(getSetting('telegram_bot_token'));
      const chatId = getSetting('telegram_chat_id');
      if (!token || !chatId || MigrationService.isBackgroundPaused()) return;
      const label = event.level === 'error' ? 'Ошибка' : event.level === 'warning' ? 'Предупреждение' : 'Событие';
      await this.send(token, chatId, `${label}: ${event.message}`);
    } catch (err) {
      console.error('Не удалось отправить уведомление в Telegram:', err instanceof Error ? err.message : 'неизвестная ошибка');
    }
  }

  private static async send(token: string, chatId: string, text: string): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json() as { ok?: boolean; description?: string };
      if (!response.ok || data.ok !== true) return { success: false, message: data.description || `Telegram вернул HTTP ${response.status}` };
      return { success: true, message: 'Тестовое сообщение отправлено' };
    } catch {
      return { success: false, message: 'Не удалось связаться с Telegram' };
    }
  }
}
