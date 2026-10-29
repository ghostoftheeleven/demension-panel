import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { useGuestLock } from './guestLock';
import { Navbar } from './components/Navbar';

vi.mock('./api', () => ({ api: { getVersion: vi.fn().mockResolvedValue({ current: 'v0.0.0', check_enabled: false, update_available: false }) } }));

const Panel: React.FC<{ guest: boolean; showLate?: boolean }> = ({ guest, showLate }) => {
  const ref = useRef<HTMLElement>(null);
  useGuestLock(guest, ref);
  return (
    <main ref={ref}>
      <button>Удалить</button>
      <input aria-label="Имя" />
      <div data-guest-ok>
        <input aria-label="Поиск" />
        <button>Страница 2</button>
      </div>
      {showLate && <button>Добавленная позже</button>}
    </main>
  );
};

describe('гостевой режим интерфейса', () => {
  it('блокирует кнопки и поля, кроме помеченных data-guest-ok', () => {
    render(<Panel guest />);
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeDisabled();
    expect(screen.getByLabelText('Имя')).toBeDisabled();
    expect(screen.getByLabelText('Поиск')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Страница 2' })).toBeEnabled();
  });

  it('не трогает интерфейс администратора', () => {
    render(<Panel guest={false} />);
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeEnabled();
  });

  it('блокирует и элементы, появившиеся позже (вкладки подгружаются лениво)', async () => {
    const { rerender } = render(<Panel guest />);
    rerender(<Panel guest showLate />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Добавленная позже' })).toBeDisabled());
  });

  it('Navbar гостя: без добавления, учётной записи и разделов настройки', () => {
    const props = {
      servers: [], user: { id: 0, username: 'guest', role: 'guest' as const }, activeTab: 'servers' as const,
      onSelectTab: vi.fn(), onAddServer: vi.fn(), onAddSubscriber: vi.fn(), onOpenAccount: vi.fn(), onLogout: vi.fn(),
    };
    render(<Navbar {...props} readOnly />);
    expect(screen.queryByRole('button', { name: /Нода/ })).toBeNull();
    expect(screen.queryByTitle(/Учётная запись/)).toBeNull();
    expect(screen.getByText('Гость')).toBeInTheDocument();
    expect(screen.queryByText('Безопасность')).toBeNull();
    expect(screen.queryByText('Оформление подписки')).toBeNull();
    expect(screen.getByText('События')).toBeInTheDocument();
  });
});
