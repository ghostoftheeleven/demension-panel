import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';

/**
 * Настоящий процесс панели (src/index.ts) с собственным каталогом данных и портом — для сквозных тестов.
 */

const SERVER_DIR = path.resolve(__dirname, '../..');
export const PANEL_USER = 'process_admin';
export const PANEL_PASSWORD = 'ProcessPassword-123';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  certFingerprint?: string;
}

export interface RequestOptions {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Запрос по TLS (самоподписанный сертификат панели не проверяется) */
  tls?: boolean;
  /** Добавить токен администратора */
  authed?: boolean;
}

export interface PanelProcess {
  child: ChildProcess;
  port: number;
  dataDir: string;
  token: string;
  output: () => string;
  request: (options: RequestOptions) => Promise<Reply>;
  /** Запрос от имени администратора с разбором JSON */
  api: (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function startPanel(extraEnv: Record<string, string> = {}): Promise<PanelProcess> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-process-'));
  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DEMENTIA_DATA_DIR: dataDir, PORT: String(port), PANEL_USER, PANEL_PASSWORD, ALLOW_INSECURE_FEDERATION: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));

  const panel: PanelProcess = {
    child,
    port,
    dataDir,
    token: '',
    output: () => output,
    request(options) {
      return new Promise((resolve, reject) => {
        const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
        const headers: Record<string, string> = { ...(options.headers || {}) };
        if (payload) headers['Content-Type'] = 'application/json';
        if (options.authed) headers.Authorization = `Bearer ${panel.token}`;
        const common = { host: '127.0.0.1', port, path: options.path, method: options.method || 'GET', headers, agent: false as const };
        const handle = (res: http.IncomingMessage) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body,
              certFingerprint: options.tls ? (res.socket as TLSSocket).getPeerCertificate().fingerprint256 : undefined,
            })
          );
        };
        const req = options.tls ? https.request({ ...common, rejectUnauthorized: false }, handle) : http.request(common, handle);
        req.once('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('timeout')));
        req.end(payload);
      });
    },
    async api(apiPath, method = 'GET', body) {
      const reply = await panel.request({ path: apiPath, method, body, authed: true });
      return { status: reply.status, body: reply.body ? JSON.parse(reply.body) : null };
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => child.once('exit', resolve));
      }
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // временный каталог удалит система
      }
    },
  };

  const started = Date.now();
  while (!output.includes('running on port')) {
    if (child.exitCode !== null) throw new Error(`Панель завершилась при запуске:\n${output}`);
    if (Date.now() - started > 45000) {
      child.kill();
      throw new Error(`Панель не запустилась за 45 с:\n${output}`);
    }
    await sleep(100);
  }
  const login = await panel.request({ path: '/api/auth/login', method: 'POST', body: { username: PANEL_USER, password: PANEL_PASSWORD } });
  panel.token = JSON.parse(login.body).token;
  return panel;
}

/** Повторяет проверку, пока она не пройдёт (для фоновых операций: синхронизация нод у владельца) */
export async function eventually<T>(check: () => Promise<T> | T, timeoutMs = 20000, intervalMs = 250): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await sleep(intervalMs);
    }
  }
}
