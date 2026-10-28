import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TelegramCard } from './TelegramCard';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getTelegramSettings: vi.fn(),
    updateTelegramSettings: vi.fn(),
    testTelegram: vi.fn(),
    detectTelegramChat: vi.fn(),
  },
}));

describe('TelegramCard', () => {
  it('позволяет проверить ещё не сохранённые токен и ID чата с передачей введённых данных', async () => {
    vi.mocked(api.getTelegramSettings).mockResolvedValue({
      enabled: true,
      chat_id: '',
      bot_token_saved: false,
      notify_info: false,
    });
    vi.mocked(api.testTelegram).mockResolvedValue({ success: true, message: 'Тестовое сообщение отправлено' });

    render(<TelegramCard />);

    const testButton = await screen.findByRole('button', { name: 'Проверить' });
    expect(testButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Токен бота'), { target: { value: '123456:token' } });
    fireEvent.change(screen.getByLabelText('ID чата'), { target: { value: '12345' } });
    expect(testButton).toBeEnabled();

    fireEvent.click(testButton);
    expect(api.testTelegram).toHaveBeenCalledWith({
      bot_token: '123456:token',
      chat_id: '12345',
    });
  });

  it('позволяет автоматически определить ID чата через бота', async () => {
    vi.mocked(api.getTelegramSettings).mockResolvedValue({
      enabled: true,
      chat_id: '',
      bot_token_saved: false,
      notify_info: false,
    });
    vi.mocked(api.detectTelegramChat).mockResolvedValue({
      success: true,
      chat_id: '987654321',
      name: '@admin',
      message: 'Найден ID чата: 987654321 (@admin)',
    });

    render(<TelegramCard />);

    const detectButton = await screen.findByRole('button', { name: /Определить мой ID/i });
    expect(detectButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Токен бота'), { target: { value: '123456:token' } });
    expect(detectButton).toBeEnabled();

    fireEvent.click(detectButton);
    expect(api.detectTelegramChat).toHaveBeenCalledWith({
      bot_token: '123456:token',
    });

    const chatIdInput = (await screen.findByLabelText('ID чата')) as HTMLInputElement;
    expect(chatIdInput.value).toBe('987654321');
  });
});
