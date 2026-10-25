import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Fail2banService } from '../src/services/fail2ban.service.js';

/**
 * Fail2banService с подставной утилитой fail2ban-client (скрипт в PATH, пишет аргументы в журнал).
 * Утилита вызывается через execFile с массивом аргументов — оболочка не участвует (инвариант 5).
 */

const isPosix = process.platform !== 'win32';

describe.skipIf(!isPosix)('Fail2banService', () => {
  let dir: string;
  let logFile: string;
  const originalPath = process.env.PATH;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-f2b-'));
    logFile = path.join(dir, 'calls.log');
    const script = `#!/bin/sh
echo "$*" >> "${logFile}"
case "$1" in
  --version) echo "1.0.2" ;;
  status)
    if [ "$FAIL2BAN_JAIL_DOWN" = 1 ]; then echo "ERROR: Failed to access socket" >&2; exit 255; fi
    printf 'Status for the jail: sshd\\n|- Filter\\n|  |- Currently failed:\\t0\\n|  |- Total failed:\\t12\\n|  \`- File list:\\t/var/log/auth.log\\n\`- Actions\\n   |- Currently banned:\\t2\\n   |- Total banned:\\t5\\n   \`- Banned IP list:\\t1.2.3.4 2001:db8::1\\n'
    ;;
  set)
    if [ "$FAIL2BAN_FAIL" = 1 ]; then echo "NOK: boom" >&2; exit 1; fi
    ;;
esac
`;
    const binary = path.join(dir, 'fail2ban-client');
    fs.writeFileSync(binary, script, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    delete process.env.FAIL2BAN_FAIL;
    delete process.env.FAIL2BAN_JAIL_DOWN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.writeFileSync(logFile, '');
    delete process.env.FAIL2BAN_FAIL;
    delete process.env.FAIL2BAN_JAIL_DOWN;
  });

  const calls = () => fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);

  it('разбирает статус jail sshd: счётчики и список забаненных адресов', async () => {
    const status = await Fail2banService.getStatus();
    expect(status).toMatchObject({
      installed: true, active: true, jail: 'sshd', totalFailed: 12, totalBanned: 5, currentlyBanned: ['1.2.3.4', '2001:db8::1'],
      maxRetry: 4, banTime: 86400, findTime: 600,
    });
    expect(calls()).toEqual(['--version', 'status sshd']);
  });

  it('если служба не запущена, утилита установлена, но неактивна', async () => {
    process.env.FAIL2BAN_JAIL_DOWN = '1';
    expect(await Fail2banService.getStatus()).toMatchObject({ installed: true, active: false, currentlyBanned: [], totalBanned: 0 });
  });

  it('ban и unban передают адрес отдельным аргументом', async () => {
    expect(await Fail2banService.banIp(' 203.0.113.9 ')).toMatchObject({ success: true });
    expect(await Fail2banService.unbanIp('2001:db8::5')).toMatchObject({ success: true });
    expect(calls()).toEqual(['set sshd banip 203.0.113.9', 'set sshd unbanip 2001:db8::5']);
  });

  it('некорректный адрес не доходит до утилиты — ни как команда, ни как аргумент', async () => {
    const injections = ['1.1.1.1; touch /tmp/pwned', '$(id)', '`id`', '1.1.1.1 && id', '1.1.1.1\nset sshd unbanip 2.2.2.2', '-h', '', null, undefined, 42, {}];
    for (const ip of injections) {
      await expect(Fail2banService.banIp(ip)).rejects.toThrow('Некорректный IP-адрес');
      await expect(Fail2banService.unbanIp(ip)).rejects.toThrow('Некорректный IP-адрес');
    }
    expect(calls()).toEqual([]);
  });

  it('ошибка утилиты передаётся с её текстом', async () => {
    process.env.FAIL2BAN_FAIL = '1';
    await expect(Fail2banService.banIp('203.0.113.9')).rejects.toThrow('Ошибка блокировки: NOK: boom');
    await expect(Fail2banService.unbanIp('203.0.113.9')).rejects.toThrow('Ошибка разблокировки: NOK: boom');
  });

  it('без установленной утилиты статус сообщает installed: false', async () => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(dir, 'empty');
    try {
      expect(await Fail2banService.getStatus()).toMatchObject({ installed: false, active: false });
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe.skipIf(isPosix)('Fail2banService на Windows', () => {
  it('недоступен: статус installed: false, настройка отклоняется', async () => {
    expect(await Fail2banService.getStatus()).toMatchObject({ installed: false, active: false });
    expect((await Fail2banService.setupLocal()).success).toBe(false);
  });
});
