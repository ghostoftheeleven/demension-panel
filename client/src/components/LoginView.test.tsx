import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginView } from './LoginView';
import { api } from '../api';

vi.mock('../api', () => ({ api: { login: vi.fn() } }));

describe('LoginView', () => {
  it('запрашивает код после ответа totp_required и отправляет его при повторном входе', async () => {
    vi.mocked(api.login)
      .mockResolvedValueOnce({ totp_required: true })
      .mockResolvedValueOnce({ token: 'token', user: { id: 1, username: 'admin' } });
    const onLoginSuccess = vi.fn();
    render(<LoginView onLoginSuccess={onLoginSuccess} />);

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти в панель' }));

    const code = await screen.findByLabelText('Код из приложения-аутентификатора');
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти в панель' }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith({ id: 1, username: 'admin' }));
    expect(api.login).toHaveBeenLastCalledWith('admin', 'password', '123456', undefined);
  });

  it('позволяет войти по одноразовому коду восстановления', async () => {
    vi.mocked(api.login)
      .mockResolvedValueOnce({ totp_required: true })
      .mockResolvedValueOnce({ token: 'token', user: { id: 1, username: 'admin' } });
    render(<LoginView onLoginSuccess={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти в панель' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Использовать код восстановления' }));
    fireEvent.change(screen.getByLabelText('Код восстановления'), { target: { value: 'ABCDEFGH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти в панель' }));

    await waitFor(() => expect(api.login).toHaveBeenLastCalledWith('admin', 'password', undefined, 'ABCDEFGH'));
  });
});
