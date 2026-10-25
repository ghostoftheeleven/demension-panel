import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { downloadMigrationArchive, notifyMigrationFinished } from '../src/services/migration-client.js';
import { deriveMigrationKeys, openArchive } from '../src/utils/migration-archive.js';
import { PANEL_PASSWORD, startPanel, type PanelProcess } from './helpers/panel-process.js';

/**
 * Перенос панели на настоящем процессе (src/index.ts): порядок middleware, блокировка записей, HTTPS с самоподписанным
 * сертификатом, заморозка и перенаправление подписок. Роутеры отдельно проверяет migration.test.ts.
 */

let panel: PanelProcess;
let base: string;

const prepare = async (tls = false) => {
  const reply = await panel.request({ path: '/api/migration/prepare', method: 'POST', authed: true, tls, body: { password: PANEL_PASSWORD } });
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body).code as string;
};
const archiveHeaders = (code: string) => ({ 'X-Migration-Auth': deriveMigrationKeys(code).auth });
const newServer = { name: 'process-node', host: '203.0.113.60', ssh_password: 'x' };

beforeAll(async () => {
  panel = await startPanel();
  base = `http://127.0.0.1:${panel.port}`;
}, 60000);

afterAll(async () => {
  await panel?.stop();
});

describe('прежняя панель (процесс): архив и блокировка записей', () => {
  it('до переноса всё работает; после выдачи архива записи отклоняются (423), чтение, вход и health — нет', async () => {
    expect((await panel.api('/api/servers', 'POST', { ...newServer, name: 'before' })).status).toBe(201);

    const code = await prepare();
    // Код выдан, но архив не забирали: записи ещё разрешены
    expect((await panel.api('/api/servers', 'POST', { ...newServer, name: 'prepared', host: '203.0.113.61' })).status).toBe(201);

    const archive = await panel.request({ path: '/api/migration/archive', headers: archiveHeaders(code) });
    expect(archive.status).toBe(200);
    expect(archive.headers['content-type']).toContain('application/octet-stream');

    const blocked = await panel.api('/api/servers', 'POST', { ...newServer, name: 'after', host: '203.0.113.62' });
    expect(blocked.status).toBe(423);
    expect(blocked.body.error).toContain('перенос');
    expect((await panel.api('/api/servers')).status).toBe(200);
    expect((await panel.api('/api/migration/status')).body.state).toBe('exporting');
    expect((await panel.request({ path: '/api/health' })).status).toBe(200);
    expect((await panel.request({ path: '/api/auth/login', method: 'POST', body: { username: 'process_admin', password: PANEL_PASSWORD } })).status).toBe(200);
    expect(panel.output()).not.toContain(code);
    expect(panel.output()).toContain('Архив переноса передан');

    // Установка ноды по WebSocket тоже меняет данные и ноду — во время переноса она недоступна
    const messages: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${panel.port}/ws`);
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token: panel.token }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'auth_ok')).toBe(true), { timeout: 5000 });
    ws.send(JSON.stringify({ type: 'start_install', serverId: 1 }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'error')).toBe(true), { timeout: 5000 });
    expect(messages.find((m) => m.type === 'error').message).toContain('Идёт перенос панели');
    expect(messages.some((m) => m.type === 'log')).toBe(false);
    ws.close();

    // Отмена возвращает запись изменений
    expect((await panel.api('/api/migration/cancel', 'POST')).status).toBe(200);
    expect((await panel.api('/api/servers', 'POST', { ...newServer, name: 'after-cancel', host: '203.0.113.63' })).status).toBe(201);
  }, 60000);

  it('клиент переноса забирает архив по HTTP тем же способом, что и установщик', async () => {
    const code = await prepare();
    const { archive, insecureTls } = await downloadMigrationArchive(base, code);
    expect(insecureTls).toBe(false);
    const { manifest, files } = openArchive(archive, deriveMigrationKeys(code).encKey);
    expect(manifest.counts.servers).toBe(3);
    expect(manifest.ssl.enabled).toBe(false);
    expect(files['demension.db']!.length).toBeGreaterThan(1000);

    await expect(downloadMigrationArchive(base, 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE')).rejects.toThrow(/Неверный или просроченный код/);
    await expect(downloadMigrationArchive(base, 'короткий')).rejects.toThrow(/Некорректный код/);
    await expect(downloadMigrationArchive('http://127.0.0.1:1', code)).rejects.toThrow(/Не удалось подключиться/);
    await panel.api('/api/migration/cancel', 'POST');
  }, 60000);
});

describe('HTTPS (самоподписанный сертификат на IP) и перенос', () => {
  let code: string;

  beforeAll(async () => {
    const issued = await panel.api('/api/security/ssl/issue-ip', 'POST', { ip: '127.0.0.1' });
    expect(issued.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    code = await prepare(true);
  }, 60000);

  it('по HTTPS архив забирается, несмотря на самоподписанный сертификат (данные зашифрованы кодом); клиент сообщает об этом', async () => {
    const { archive, insecureTls } = await downloadMigrationArchive(`https://127.0.0.1:${panel.port}`, code);
    expect(insecureTls).toBe(true);
    const { manifest, files } = openArchive(archive, deriveMigrationKeys(code).encKey);
    expect(manifest.ssl).toMatchObject({ enabled: true, mode: 'selfsigned_ip', domain: '127.0.0.1', hasFiles: true });
    // Сертификат и ключ TLS едут в архиве: он действителен и для нового сервера, если останется прежний адрес
    expect(files['ssl/fullchain.pem']!.toString()).toContain('BEGIN CERTIFICATE');
    expect(files['ssl/privkey.pem']!.toString()).toContain('PRIVATE KEY');
  }, 60000);

  it('по обычному HTTP при включённом HTTPS панель отвечает 403, а клиент подсказывает использовать https://', async () => {
    await expect(downloadMigrationArchive(base, code)).rejects.toThrow(/только по HTTPS: укажите адрес с https:\/\//);
    // Проверка запуска для установщика по HTTP при этом работает
    expect((await panel.request({ path: '/api/health' })).status).toBe(200);
  }, 30000);

  it('завершение переноса: панель замораживается, вход и API — 410 по HTTPS, health — 200, подписки по HTTP перенаправляются на новый адрес', async () => {
    await notifyMigrationFinished(`https://127.0.0.1:${panel.port}`, code, 'https://new.example.com:3001/ignored');

    const login = await panel.request({ path: '/api/auth/login', method: 'POST', tls: true, body: { username: 'process_admin', password: PANEL_PASSWORD } });
    expect(login.status).toBe(410);
    expect(JSON.parse(login.body)).toMatchObject({ migrated: true, newUrl: 'https://new.example.com:3001' });
    expect((await panel.request({ path: '/api/servers', tls: true, authed: true })).status).toBe(410);
    expect((await panel.request({ path: '/api/health', tls: true })).status).toBe(200);

    const sub = await panel.request({ path: '/sub/sub_any_token?format=clash' });
    expect(sub.status).toBe(308);
    expect(sub.headers.location).toBe('https://new.example.com:3001/sub/sub_any_token?format=clash');
    const subTls = await panel.request({ path: '/sub/sub_any_token', tls: true });
    expect(subTls.status).toBe(308);

    // Повторное завершение и забор архива невозможны
    await expect(notifyMigrationFinished(`https://127.0.0.1:${panel.port}`, code, 'https://other.example.com')).rejects.toThrow();
    expect(panel.child.exitCode).toBeNull();
    expect(panel.output()).toContain('Перенос завершён, панель заморожена');
  }, 60000);
});
