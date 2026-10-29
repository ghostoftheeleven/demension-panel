import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ModalShell } from './Modal';
import { FeedbackProvider, useFeedback } from './Feedback';

const Host: React.FC<{ onClose?: () => void }> = ({ onClose = () => {} }) => {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button>снаружи</button>
      {open && (
        <ModalShell label="Тест" onClose={() => { onClose(); setOpen(false); }}>
          <div>
            <input aria-label="поле" />
            <button>действие</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
};

describe('ModalShell', () => {
  it('объявляет диалог и переводит фокус внутрь', () => {
    render(<Host />);
    const dialog = screen.getByRole('dialog', { name: 'Тест' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('закрывается по Esc и возвращает фокус туда, где он был', () => {
    const onClose = vi.fn();
    const { rerender } = render(<div><button>до окна</button></div>);
    const before = screen.getByText('до окна');
    before.focus();
    rerender(<div><button>до окна</button><Host onClose={onClose} /></div>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it('держит Tab внутри окна', () => {
    render(<Host />);
    const button = screen.getByText('действие');
    button.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('поле'));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(button);
  });

  it('блокирует прокрутку страницы, пока окно открыто', () => {
    const { unmount } = render(<Host />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('Esc закрывает только верхнее из окон (открытое позже)', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const { rerender } = render(
      <ModalShell label="нижнее" onClose={outer}>
        <button>a</button>
      </ModalShell>
    );
    rerender(
      <>
        <ModalShell label="нижнее" onClose={outer}>
          <button>a</button>
        </ModalShell>
        <ModalShell label="верхнее" onClose={inner} elevated>
          <button>b</button>
        </ModalShell>
      </>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

const Probe: React.FC<{ onResult: (v: unknown) => void }> = ({ onResult }) => {
  const { toast, confirm, alert } = useFeedback();
  return (
    <>
      <button onClick={() => toast('Готово', 'success')}>тост</button>
      <button onClick={() => toast('Сломалось', 'error')}>ошибка</button>
      <button onClick={async () => onResult(await confirm({ message: 'Удалить?', danger: true, confirmLabel: 'Удалить' }))}>вопрос</button>
      <button onClick={async () => onResult(await alert('Длинный текст', 'Итог'))}>сообщение</button>
    </>
  );
};

describe('Feedback', () => {
  it('показывает тост (ошибка — role=alert) и закрывает его вручную', () => {
    render(<FeedbackProvider><Probe onResult={() => {}} /></FeedbackProvider>);
    fireEvent.click(screen.getByText('тост'));
    expect(screen.getByRole('status')).toHaveTextContent('Готово');
    fireEvent.click(screen.getByText('ошибка'));
    expect(screen.getByRole('alert')).toHaveTextContent('Сломалось');
    fireEvent.click(screen.getAllByLabelText('Закрыть уведомление')[0]);
    expect(screen.queryByText('Готово')).toBeNull();
  });

  it('confirm возвращает true по кнопке и false по Esc или отмене', async () => {
    const results: unknown[] = [];
    render(<FeedbackProvider><Probe onResult={(v) => results.push(v)} /></FeedbackProvider>);

    fireEvent.click(screen.getByText('вопрос'));
    expect(screen.getByRole('dialog', { name: 'Подтвердите действие' })).toHaveTextContent('Удалить?');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Удалить' })); });

    fireEvent.click(screen.getByText('вопрос'));
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });

    fireEvent.click(screen.getByText('вопрос'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Отмена' })); });

    expect(results).toEqual([true, false, false]);
  });

  it('alert ждёт нажатия «Понятно»', async () => {
    const results: unknown[] = [];
    render(<FeedbackProvider><Probe onResult={(v) => results.push(v)} /></FeedbackProvider>);
    fireEvent.click(screen.getByText('сообщение'));
    expect(screen.getByRole('dialog', { name: 'Итог' })).toHaveTextContent('Длинный текст');
    expect(screen.queryByRole('button', { name: 'Отмена' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Понятно' })); });
    expect(results).toEqual([undefined]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
