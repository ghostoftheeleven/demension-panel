import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { InstallApp } from '../pwa';
import { InstallAppButton } from './InstallAppButton';

const state = vi.hoisted(() => ({ app: null as unknown as InstallApp }));
vi.mock('../pwa', () => ({ useInstallApp: () => state.app }));

const app = (patch: Partial<InstallApp>): InstallApp => ({
  platform: 'other', standalone: false, secure: true, canPrompt: false, visible: true, install: vi.fn(async () => true), ...patch,
});

beforeEach(() => {
  state.app = app({});
});

const button = () => screen.queryByRole('button', { name: 'Установить панель как приложение' });

describe('InstallAppButton', () => {
  it('скрыта, когда установка недоступна или панель уже открыта как приложение', () => {
    state.app = app({ visible: false });
    render(<InstallAppButton />);
    expect(button()).toBeNull();
  });

  it('если браузер умеет сам — вызывает системный диалог и не открывает инструкцию', async () => {
    state.app = app({ canPrompt: true });
    render(<InstallAppButton />);
    await act(async () => {
      fireEvent.click(button()!);
    });
    expect(state.app.install).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('iOS: шаги через Safari и «Поделиться → На экран „Домой“»; закрывается по Esc', () => {
    state.app = app({ platform: 'ios', secure: true });
    render(<InstallAppButton />);
    fireEvent.click(button()!);
    const dialog = screen.getByRole('dialog', { name: 'Установка панели как приложения' });
    expect(dialog).toHaveTextContent('Safari');
    expect(dialog).toHaveTextContent('На экран „Домой“');
    expect(dialog).not.toHaveTextContent('Панель открыта по HTTP');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Android по HTTP: предупреждает, что полноценная установка требует HTTPS', () => {
    state.app = app({ platform: 'android', secure: false });
    render(<InstallAppButton />);
    fireEvent.click(button()!);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Установить приложение');
    expect(dialog).toHaveTextContent('Панель открыта по HTTP');
    expect(dialog).toHaveTextContent('только по HTTPS');
  });

  it('iOS по HTTP: ярлык добавится, но офлайн-оболочки не будет', () => {
    state.app = app({ platform: 'ios', secure: false });
    render(<InstallAppButton />);
    fireEvent.click(button()!);
    expect(screen.getByRole('dialog')).toHaveTextContent('офлайн-оболочка');
  });
});
