import { vi } from 'vitest';
import { SshService } from '../../src/services/ssh.service.js';

export interface SshCall {
  command: string;
  input?: string;
}

export type SshResult = { code: number; stdout: string; stderr: string };
export type SshResponder = (call: SshCall) => Partial<SshResult> | Promise<Partial<SshResult>> | void;

/**
 * Подмена SshService.executeCommand: команды записываются в calls, ответ задаёт responder
 * (по умолчанию — успех с пустым выводом). Для ошибки соединения responder может бросить исключение.
 */
export function stubSsh(responder: SshResponder = () => ({})) {
  const calls: SshCall[] = [];
  const spy = vi.spyOn(SshService, 'executeCommand').mockImplementation(async (_credentials, command, options) => {
    const opts = typeof options === 'function' ? {} : options ?? {};
    const call: SshCall = { command, input: opts.input };
    calls.push(call);
    const result = (await responder(call)) ?? {};
    return { code: 0, stdout: '', stderr: '', ...result };
  });
  return { calls, spy };
}
