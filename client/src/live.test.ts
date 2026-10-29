import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLiveUpdates } from './live';

vi.mock('./api', () => ({ getToken: () => 'tok-123' }));

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

describe('useLiveUpdates', () => {
  it('авторизуется первым сообщением, становится «подключён» после auth_ok и обновляет данные по changed', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useLiveUpdates(true, onChange));
    expect(last().url).toMatch(/^wss?:\/\/.+\/ws$/);
    act(() => last().onopen?.());
    expect(JSON.parse(last().sent[0])).toEqual({ type: 'auth', token: 'tok-123' });
    expect(result.current).toBe(false);

    act(() => last().receive({ type: 'auth_ok' }));
    expect(result.current).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => last().receive({ type: 'changed' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    act(() => last().receive({ type: 'log', data: 'x' }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('при обрыве переподключается с нарастающей паузой', () => {
    renderHook(() => useLiveUpdates(true, vi.fn()));
    act(() => last().onclose?.({ code: 1006 }));
    expect(FakeSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => last().onclose?.({ code: 1006 }));
    act(() => vi.advanceTimersByTime(1999));
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('после успешной авторизации пауза сбрасывается', () => {
    renderHook(() => useLiveUpdates(true, vi.fn()));
    act(() => last().onclose?.({ code: 1006 }));
    act(() => vi.advanceTimersByTime(1000));
    act(() => last().onclose?.({ code: 1006 }));
    act(() => vi.advanceTimersByTime(2000));
    act(() => last().receive({ type: 'auth_ok' }));
    act(() => last().onclose?.({ code: 1006 }));
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('код 4401 (сессия недействительна) — без повторных попыток', () => {
    renderHook(() => useLiveUpdates(true, vi.fn()));
    act(() => last().onclose?.({ code: 4401 }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('выключенный хук (гость, нет входа) сокет не открывает, а при размонтировании сокет закрывается', () => {
    const off = renderHook(() => useLiveUpdates(false, vi.fn()));
    expect(FakeSocket.instances).toHaveLength(0);
    off.unmount();

    const on = renderHook(() => useLiveUpdates(true, vi.fn()));
    const socket = last();
    on.unmount();
    expect(socket.closed).toBe(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('возврат на вкладку обновляет данные', () => {
    const onChange = vi.fn();
    renderHook(() => useLiveUpdates(true, onChange));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
