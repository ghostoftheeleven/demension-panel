import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dataDir } from '../config.js';
import { panelEnv } from '../utils/env.js';
import { HttpError } from '../utils/http.js';
import { PANEL_VERSION, parseVersion, VersionService } from './version.service.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Служба systemd, в которой идёт обновление: install.sh останавливает dementia.service, а эта продолжает работать */
export const UPDATE_UNIT = 'dementia-update';
/** Обновление, которое «идёт» дольше, считается прерванным (перезагрузка сервера, убитый процесс) */
const STALE_MS = 45 * 60 * 1000;
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_TAIL_LINES = 300;

export type UpdateState = 'idle' | 'running' | 'success' | 'failed' | 'rolled_back';
const STATES: UpdateState[] = ['idle', 'running', 'success', 'failed', 'rolled_back'];

export interface UpdateStatus {
  /** Можно ли обновить панель из интерфейса; иначе reason — почему и что делать */
  available: boolean;
  reason: string | null;
  current: string;
  state: UpdateState;
  from: string | null;
  to: string | null;
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
  log: string;
}

/** Каталог панели (клон git с install.sh): src/services и dist/services лежат на два уровня ниже server/ */
export const installDir = path.resolve(__dirname, '../../..');
export const updateStateDir = path.join(dataDir, 'update');
const statusFile = () => path.join(updateStateDir, 'status.json');
const logFile = () => path.join(updateStateDir, 'update.log');

function findScript(): string | null {
  const candidates = [
    path.resolve(__dirname, '../scripts/update-panel.sh'),
    path.resolve(installDir, 'server/src/scripts/update-panel.sh'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function findSystemdRun(): string | null {
  return ['/usr/bin/systemd-run', '/bin/systemd-run'].find((candidate) => fs.existsSync(candidate)) ?? null;
}

const isoOrNull = (value: unknown) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);
const versionOrNull = (value: unknown) => (parseVersion(value) ? String(value) : null);

interface StoredStatus {
  state: UpdateState;
  from: string | null;
  to: string | null;
  started_at: string | null;
  finished_at: string | null;
  message: string | null;
}

const IDLE: StoredStatus = { state: 'idle', from: null, to: null, started_at: null, finished_at: null, message: null };

/** status.json пишет скрипт обновления; файл разбирается строго — в интерфейс попадают только поля известного формата */
function readStoredStatus(): StoredStatus {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(statusFile(), 'utf-8'));
  } catch {
    return IDLE;
  }
  if (!raw || !STATES.includes(raw.state)) return IDLE;
  const status: StoredStatus = {
    state: raw.state,
    from: versionOrNull(raw.from),
    to: versionOrNull(raw.to),
    started_at: isoOrNull(raw.started_at),
    finished_at: isoOrNull(raw.finished_at),
    message: typeof raw.message === 'string' ? raw.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : null,
  };
  if (status.state === 'running') {
    const started = status.started_at ? Date.parse(status.started_at) : 0;
    if (Date.now() - started > STALE_MS) {
      return { ...status, state: 'failed', message: 'Обновление прервано (сервер перезагружен или процесс остановлен). Проверьте журнал' };
    }
  }
  return status;
}

function writeStoredStatus(status: StoredStatus) {
  fs.mkdirSync(updateStateDir, { recursive: true, mode: 0o700 });
  const tmp = `${statusFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, statusFile());
}

/** Последние строки журнала обновления без управляющих последовательностей терминала (цвета install.sh) */
function readLogTail(): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(logFile(), 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer
      .toString('utf-8')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r(?!\n)/g, '\n')
      .trimEnd()
      .split(/\r?\n/);
    if (size > length) lines.shift(); // первая строка обрезана посередине
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export class UpdateService {
  /**
   * Почему панель нельзя обновить из интерфейса (null — можно). Нужна установка install.sh: клон git, служба systemd от root
   * и systemd-run, чтобы обновление пережило остановку службы панели.
   */
  static environmentProblem(): string | null {
    if (panelEnv('SELF_UPDATE') === '0') return 'Обновление из панели отключено (DEMENTIA_SELF_UPDATE=0 в server/.env)';
    if (process.platform !== 'linux') return 'Обновление из панели работает только на Linux-сервере, где панель установлена через install.sh';
    if (!process.env.INVOCATION_ID) return 'Панель запущена не службой systemd (install.sh) — обновите её из терминала';
    if (typeof process.getuid === 'function' && process.getuid() !== 0) return 'Служба панели работает не от root — обновите панель из терминала';
    if (!fs.existsSync(path.join(installDir, '.git')) || !fs.existsSync(path.join(installDir, 'install.sh'))) {
      return `Каталог панели (${installDir}) не является клоном git — обновите панель командой установки из терминала`;
    }
    if (!findSystemdRun()) return 'На сервере нет systemd-run — обновите панель из терминала';
    if (!findScript()) return 'Не найден скрипт обновления (server/dist/scripts/update-panel.sh) — обновите панель из терминала';
    return null;
  }

  static getStatus(): UpdateStatus {
    const reason = this.environmentProblem();
    return { available: !reason, reason, current: PANEL_VERSION, ...readStoredStatus(), log: readLogTail() };
  }

  /**
   * Запускает обновление до последнего релиза GitHub. Версия из запроса должна совпасть с последним релизом, который видит
   * панель: обновиться можно только на опубликованный релиз и только вперёд.
   */
  static async start(version: unknown): Promise<UpdateStatus> {
    const reason = this.environmentProblem();
    if (reason) throw new HttpError(409, reason);
    if (readStoredStatus().state === 'running') throw new HttpError(409, 'Обновление уже выполняется');

    const info = await VersionService.getInfo();
    if (!info.check_enabled) throw new HttpError(409, 'Проверка обновлений отключена (DEMENTIA_UPDATE_CHECK=0) — обновите панель из терминала');
    if (!info.update_available || !info.latest) throw new HttpError(409, 'Установлена последняя версия панели');
    if (version !== info.latest) throw new HttpError(409, `Последняя версия панели — ${info.latest}. Обновите страницу`);
    const target = info.latest;

    // Копия скрипта: во время обновления git и сборка заменяют файлы в каталоге панели
    const source = findScript()!;
    fs.mkdirSync(updateStateDir, { recursive: true, mode: 0o700 });
    const runner = path.join(updateStateDir, 'update-panel.sh');
    fs.copyFileSync(source, runner);
    fs.chmodSync(runner, 0o700);

    const startedAt = new Date().toISOString();
    writeStoredStatus({ state: 'running', from: PANEL_VERSION, to: target, started_at: startedAt, finished_at: null, message: `Обновление до ${target}` });
    fs.writeFileSync(logFile(), '', { mode: 0o600 });
    try {
      await this.launch([runner, installDir, updateStateDir, target, PANEL_VERSION]);
    } catch (err: any) {
      const detail = String(err?.stderr || err?.message || 'ошибка запуска').trim().split('\n')[0].slice(0, 200);
      writeStoredStatus({
        state: 'failed', from: PANEL_VERSION, to: target, started_at: startedAt, finished_at: new Date().toISOString(),
        message: `Не удалось запустить обновление: ${detail}`,
      });
      throw new HttpError(500, `Не удалось запустить обновление: ${detail}`);
    }
    console.log(`[UPDATE] Запущено обновление панели ${PANEL_VERSION} → ${target} (служба ${UPDATE_UNIT})`);
    return this.getStatus();
  }

  /** Отдельная служба systemd: процесс обновления не принадлежит службе панели и переживает её остановку */
  static async launch(args: string[]): Promise<void> {
    await execFileAsync(findSystemdRun()!, [
      `--unit=${UPDATE_UNIT}`,
      '--collect',
      '--quiet',
      '--description=Dementia Panel update',
      '--setenv=HOME=/root',
      '/bin/bash',
      ...args,
    ], { timeout: 30000 });
  }
}
