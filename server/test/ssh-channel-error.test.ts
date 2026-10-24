import type { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SshService } from '../src/services/ssh.service.js';

// Подменённый ssh2: клиент сразу «подключается», а канал команды доступен тесту через globalThis
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeStream extends EventEmitter {
    stderr = new EventEmitter();
    end() {}
  }
  class Client extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'));
      return this;
    }
    exec(_command: string, callback: (err: Error | undefined, stream: FakeStream) => void) {
      const stream = new FakeStream();
      (globalThis as any).__fakeSshStream = stream;
      callback(undefined, stream);
    }
    end() {}
  }
  return { Client };
});

const fakeStream = () => (globalThis as any).__fakeSshStream as EventEmitter & { stderr: EventEmitter };
const channelReady = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('#34 ошибки канала SSH', () => {
  it('ошибка канала завершает команду отказом, а не роняет процесс (Unhandled error event)', async () => {
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true');
    const assertion = expect(pending).rejects.toThrow('channel reset');
    await channelReady();

    expect(() => fakeStream().emit('error', new Error('channel reset'))).not.toThrow();
    await assertion;
  });

  it('ошибка потока stderr обрабатывается так же', async () => {
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true');
    const assertion = expect(pending).rejects.toThrow('stderr broken');
    await channelReady();

    expect(() => fakeStream().stderr.emit('error', new Error('stderr broken'))).not.toThrow();
    await assertion;
  });

  it('ошибка после завершения команды игнорируется', async () => {
    const pending = SshService.executeCommand({ host: 'node.example.com' }, 'true');
    await channelReady();
    const stream = fakeStream();
    stream.emit('data', Buffer.from('ok'));
    stream.emit('close', 0);
    await expect(pending).resolves.toMatchObject({ code: 0, stdout: 'ok' });

    expect(() => stream.emit('error', new Error('late error'))).not.toThrow();
  });
});
