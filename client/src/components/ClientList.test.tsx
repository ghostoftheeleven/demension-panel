import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { Client } from '../types';
import { FeedbackProvider } from './ui/Feedback';
import { ClientList } from './ClientList';

const api = vi.hoisted(() => ({
  updateClient: vi.fn(),
  deleteClient: vi.fn(),
  downloadClientConfig: vi.fn(),
}));
vi.mock('../api', () => ({ api }));

const now = Date.now();
const client = (id: number, patch: Partial<Client> = {}): Client =>
  ({
    id, server_id: 1, name: `client-${id}`, client_ip: `10.8.0.${id}`, enabled: 1, external: false, owner_blocked: false, pending: false,
    remote_state: null, partner_name: null, total_rx: id * 1000, total_tx: id * 5000, last_handshake: new Date(now - id * 1000).toISOString(),
    ...patch,
  }) as Client;

function setup(clients: Client[], layout: 'table' | 'cards' = 'table') {
  const handlers = { onAddClient: vi.fn(), onShowQr: vi.fn(), onClientUpdated: vi.fn(), onClientDeleted: vi.fn() };
  render(
    <FeedbackProvider>
      <ClientList clients={clients} serverName="node" layout={layout} {...handlers} />
    </FeedbackProvider>
  );
  return handlers;
}

const rowNames = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getByText(/^client-\d+$/).textContent);

beforeEach(() => {
  api.updateClient.mockReset().mockImplementation(async (id: number, data: { enabled: number }) => client(id, { enabled: data.enabled }));
  api.deleteClient.mockReset().mockResolvedValue(undefined);
});

describe('ClientList', () => {
  it('имя клиента лежит в обычной ячейке таблицы: строка не ломается (td не flex)', () => {
    setup([client(1)]);
    const cell = screen.getByText('client-1').closest('td')!;
    expect(cell.className).not.toMatch(/\bflex\b/);
  });

  it('сортирует по клику на заголовок и меняет направление повторным кликом', () => {
    setup([client(2), client(10), client(1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Имя' }));
    expect(rowNames()).toEqual(['client-1', 'client-2', 'client-10']);
    expect(screen.getByRole('columnheader', { name: /Имя/ })).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Имя' }));
    expect(rowNames()).toEqual(['client-10', 'client-2', 'client-1']);
  });

  it('фильтрует по имени или IP', () => {
    setup([client(1), client(2), client(3)]);
    fireEvent.change(screen.getByLabelText('Поиск клиентов'), { target: { value: '10.8.0.3' } });
    expect(rowNames()).toEqual(['client-3']);
  });

  it('постранично показывает длинные списки', () => {
    setup(Array.from({ length: 30 }, (_, i) => client(i + 1)));
    expect(rowNames()).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: /Показать ещё \(5\)/ }));
    expect(rowNames()).toHaveLength(30);
  });

  it('массово отключает выбранных клиентов и пропускает уже отключённых', async () => {
    const h = setup([client(1), client(2), client(3, { enabled: 0 })]);
    fireEvent.click(screen.getByLabelText('Выбрать всех показанных клиентов'));
    expect(screen.getByText('Выбрано: 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отключить' }));
    await waitFor(() => expect(h.onClientUpdated).toHaveBeenCalledTimes(2));
    expect(api.updateClient).toHaveBeenCalledWith(1, { enabled: 0 });
    expect(api.updateClient).toHaveBeenCalledWith(2, { enabled: 0 });
    expect(api.updateClient).not.toHaveBeenCalledWith(3, expect.anything());
    expect(await screen.findByText('Отключено: 2')).toBeInTheDocument();
  });

  it('массовое удаление спрашивает подтверждение, не трогает клиентов партнёров и не падает от ошибки одного', async () => {
    api.deleteClient.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error('нода недоступна');
    });
    const h = setup([client(1), client(2), client(3, { partner_name: 'Vault' })]);
    fireEvent.click(screen.getByLabelText('Выбрать всех показанных клиентов'));
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Удалить клиентов: 2');
    expect(dialog).toHaveTextContent('партнёров (1)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));

    await waitFor(() => expect(h.onClientDeleted).toHaveBeenCalledTimes(1));
    expect(h.onClientDeleted).toHaveBeenCalledWith(1);
    expect(api.deleteClient).not.toHaveBeenCalledWith(3);
    expect(await screen.findByText(/Удалено: 1, с ошибкой: 1/)).toBeInTheDocument();
  });

  it('отмена подтверждения ничего не удаляет', async () => {
    setup([client(1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить клиента client-1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.deleteClient).not.toHaveBeenCalled();
  });

  it('в компактном виде (инспектор) те же действия доступны карточками', () => {
    setup([client(1), client(2)], 'cards');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByLabelText('Сортировка клиентов')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^Выбрать клиента/)).toHaveLength(2);
  });
});
