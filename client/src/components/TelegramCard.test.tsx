import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TelegramCard } from './TelegramCard';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    getTelegramSettings: vi.fn(),
    updateTelegramSettings: vi.fn(),
    testTelegram: vi.fn(),
  },
}));

describe('TelegramCard', () => {
  it('позволяет проверить ещё не сохранённые токен и ID чата', async () => {
    vi.mocked(api.getTelegramSettings).mockResolvedValue({
      enabled: true,
      chat_id: '',
      bot_token_saved: false,
      notify_info: false,
    });
    render(<TelegramCard />);

    const testButton = await screen.findByRole('button', { name: 'Проверить' });
    expect(testButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Токен бота'), { target: { value: '123456:token' } });
    fireEvent.change(screen.getByLabelText('ID чата'), { target: { value: '12345' } });
    expect(testButton).toBeEnabled();

    fireEvent.click(testButton);
    expect(api.testTelegram).toHaveBeenCalledOnce();
  });
});
