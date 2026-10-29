import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ConnectionLost } from './ConnectionLost';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionLost', () => {
  it('сообщает об обрыве связи (не о выходе из системы) и повторяет по кнопке', async () => {
    const onRetry = vi.fn(async () => {});
    render(<ConnectionLost onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Нет связи с панелью');
    expect(screen.getByRole('alert')).toHaveTextContent('Вы остаётесь в системе');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('сама повторяет попытку при возврате сети и каждые 10 секунд, а после размонтирования замолкает', () => {
    const onRetry = vi.fn();
    const { unmount } = render(<ConnectionLost onRetry={onRetry} />);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
    unmount();
    act(() => {
      window.dispatchEvent(new Event('online'));
      vi.advanceTimersByTime(30_000);
    });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});
