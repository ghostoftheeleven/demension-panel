import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Скрипт обновления панели из интерфейса (src/scripts/update-panel.sh) на настоящих git и bash: настоящий репозиторий с
 * тегами релизов, а вместо install.sh релиза — короткий install.sh, который делает то же, что и настоящий (ff-merge тега,
 * остановка службы, резервная копия БД, изменение БД новой версией, перезапуск). Подменены systemctl, npm и curl.
 * Полный путь с настоящим install.sh проверяет server/test/install/upgrade.sh.
 *
 * На Windows нужен bash из Git for Windows: TEST_BASH=C:/Program Files/Git/bin/bash.exe (иначе тесты пропускаются).
 */

const BASH = process.env.TEST_BASH || (process.platform === 'win32' ? '' : 'bash');
const script = path.resolve(__dirname, '../src/scripts/update-panel.sh');
const slash = (p: string) => p.replace(/\\/g, '/');

// install.sh релиза в тестовом репозитории
const FAKE_INSTALL = `#!/bin/bash
set -e
[ -f "$STUB_DIR/early-fail" ] && { echo "нет сети"; exit 1; }
git -c safe.directory="$PWD" fetch --no-tags origin "+refs/tags/$PANEL_UPDATE_REF:refs/tags/$PANEL_UPDATE_REF"
git -c safe.directory="$PWD" merge --ff-only "refs/tags/$PANEL_UPDATE_REF"
systemctl stop dementia.service
mkdir -p data/backups
for f in data/dementia.db* data/demension.db*; do [ -f "$f" ] || continue; cp -a "$f" "data/backups/$(basename "$f").$(date +%Y%m%d-%H%M%S)"; done
# Новая версия при запуске переименовывает файл БД версий до v0.1.4
if [ -f data/demension.db ]; then mv data/demension.db data/dementia.db; fi
echo "migrated by $PANEL_UPDATE_REF" > data/dementia.db
if [ -f "$STUB_DIR/install-fail" ]; then printf '\\033[0;31mсборка не удалась\\033[0m\\n'; exit 1; fi
systemctl restart dementia.service
`;

const STUBS: Record<string, string> = {
  systemctl: `#!/bin/bash
echo "systemctl $*" >> "$STUB_DIR/calls.log"
case "$1" in
  stop) rm -f "$STUB_DIR/up" ;;
  start|restart) touch "$STUB_DIR/up" ;;
  is-active) [ -f "$STUB_DIR/up" ] ;;
esac
`,
  npm: `#!/bin/bash
echo "npm $*" >> "$STUB_DIR/calls.log"
[ ! -f "$STUB_DIR/npm-fail" ]
`,
  curl: `#!/bin/bash
echo "curl $*" >> "$STUB_DIR/calls.log"
[ -f "$STUB_DIR/up" ]
`,
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf-8' }).trim();

describe.skipIf(!BASH)('скрипт обновления панели (update-panel.sh)', () => {
  let root: string;
  let origin: string;
  let installDir: string;
  let stateDir: string;
  let stubDir: string;
  const rev: Record<string, string> = {};

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-update-'));
    origin = path.join(root, 'origin.git');
    const seed = path.join(root, 'seed');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'init', '-q', '-b', 'main', seed);
    fs.writeFileSync(path.join(seed, '.gitignore'), 'data/\nserver/.env\n');
    fs.writeFileSync(path.join(seed, 'install.sh'), FAKE_INSTALL);
    for (const version of ['1.0.0', '1.1.0']) {
      fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'dementia-panel', version }) + '\n');
      git(seed, 'add', '-A');
      git(seed, 'commit', '-q', '-m', `release ${version}`);
      git(seed, 'tag', `v${version}`);
      rev[`v${version}`] = git(seed, 'rev-parse', 'HEAD');
    }
    git(seed, 'push', '-q', origin, 'main', '--tags');
  });

  beforeEach(() => {
    const run = fs.mkdtempSync(path.join(root, 'run-'));
    installDir = path.join(run, 'panel');
    stateDir = path.join(installDir, 'data', 'update');
    stubDir = path.join(run, 'stubs');
    git(run, 'clone', '-q', origin, installDir);
    git(installDir, 'reset', '-q', '--hard', 'v1.0.0'); // установлена прежняя версия
    fs.mkdirSync(path.join(installDir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(installDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'data', 'dementia.db'), 'ORIGINAL\n');
    fs.writeFileSync(path.join(installDir, 'server', '.env'), 'PORT=3999\nNODE_ENV=production\n');
    fs.mkdirSync(stubDir);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(stubDir, name), body, { mode: 0o755 });
    fs.writeFileSync(path.join(stubDir, 'up'), ''); // панель работает
  });

  function update(target: string, from = 'v1.0.0') {
    // Подставные systemctl/npm/curl — первыми в PATH (cygpath переводит путь для bash из Git for Windows)
    const wrapper = 'STUB_DIR="$(cygpath -u "$STUB_DIR" 2>/dev/null || printf %s "$STUB_DIR")"; export STUB_DIR; export PATH="$STUB_DIR:$PATH"; exec bash "$@"';
    const result = spawnSync(BASH, ['-c', wrapper, 'update', slash(script), slash(installDir), slash(stateDir), target, from], {
      env: { ...process.env, STUB_DIR: slash(stubDir) },
      encoding: 'utf-8',
      timeout: 120000,
    });
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '');
    return {
      code: result.status,
      status: fs.existsSync(path.join(stateDir, 'status.json')) ? JSON.parse(read(path.join(stateDir, 'status.json'))) : null,
      log: read(path.join(stateDir, 'update.log')),
      calls: read(path.join(stubDir, 'calls.log')),
      head: git(installDir, 'rev-parse', 'HEAD'),
      db: read(path.join(installDir, 'data', 'dementia.db')),
      legacyDb: read(path.join(installDir, 'data', 'demension.db')),
      up: fs.existsSync(path.join(stubDir, 'up')),
    };
  }

  it('обновляет до тега релиза: install.sh из нового релиза, состояние «успех», журнал', () => {
    const r = update('v1.1.0');
    expect(r.code).toBe(0);
    expect(r.status).toMatchObject({ state: 'success', from: 'v1.0.0', to: 'v1.1.0', message: 'Панель обновлена до v1.1.0' });
    expect(Date.parse(r.status.finished_at)).not.toBeNaN();
    expect(r.head).toBe(rev['v1.1.0']);
    expect(r.db).toBe('migrated by v1.1.0\n');
    expect(r.up).toBe(true);
    expect(r.log).toContain('=== Панель обновлена до v1.1.0');
    expect(r.calls).toContain('curl -fsS --max-time 2 http://127.0.0.1:3999/api/health');
    // Временная копия install.sh удалена
    expect(fs.existsSync(path.join(stateDir, 'install.sh'))).toBe(false);
  });

  it('сбой после смены кода — откат: прежний коммит, БД из резервной копии, сборка, запуск', () => {
    fs.writeFileSync(path.join(stubDir, 'install-fail'), '');
    const r = update('v1.1.0');
    expect(r.code).toBe(1);
    expect(r.status).toMatchObject({ state: 'rolled_back', from: 'v1.0.0', to: 'v1.1.0' });
    expect(r.status.message).toContain('возвращена на v1.0.0');
    expect(r.head).toBe(rev['v1.0.0']);
    expect(r.db).toBe('ORIGINAL\n');
    expect(r.calls).toContain('npm ci --prefix server');
    expect(r.calls).toContain('npm run build');
    expect(r.calls.trim().split('\n').filter((l) => l.startsWith('systemctl')).at(-1)).not.toContain('stop');
    expect(r.up).toBe(true);
    expect(r.log).toContain('сборка не удалась');
    expect(r.log).toContain('БД восстановлена из резервной копии');
  });

  it('не удался и откат — состояние «не удалось», служба всё равно запускается', () => {
    fs.writeFileSync(path.join(stubDir, 'install-fail'), '');
    fs.writeFileSync(path.join(stubDir, 'npm-fail'), '');
    const r = update('v1.1.0');
    expect(r.code).toBe(1);
    expect(r.status.state).toBe('failed');
    expect(r.status.message).toContain('откат не удались');
    expect(r.head).toBe(rev['v1.0.0']);
    expect(r.calls).toContain('systemctl start dementia.service');
    expect(r.up).toBe(true);
  });

  it('install.sh упал до смены кода — откат не нужен, панель работает на прежней версии', () => {
    fs.writeFileSync(path.join(stubDir, 'early-fail'), '');
    const r = update('v1.1.0');
    expect(r.code).toBe(1);
    expect(r.status).toMatchObject({ state: 'failed', to: 'v1.1.0' });
    expect(r.status.message).toContain('код панели не менялся');
    expect(r.head).toBe(rev['v1.0.0']);
    expect(r.db).toBe('ORIGINAL\n');
    expect(r.calls).not.toContain('npm');
    expect(r.up).toBe(true);
  });

  it('релиза нет в репозитории — ничего не меняется', () => {
    const r = update('v9.9.9');
    expect(r.code).toBe(1);
    expect(r.status.state).toBe('failed');
    expect(r.status.message).toContain('Не удалось скачать релиз v9.9.9');
    expect(r.head).toBe(rev['v1.0.0']);
    expect(r.db).toBe('ORIGINAL\n');
    expect(r.calls).not.toContain('systemctl stop');
  });

  it('откат с версии, где БД ещё называлась demension.db: восстанавливается файл с прежним именем', () => {
    // Установлена версия до переименования проекта (Demension): её БД — demension.db
    fs.renameSync(path.join(installDir, 'data', 'dementia.db'), path.join(installDir, 'data', 'demension.db'));
    fs.writeFileSync(path.join(stubDir, 'install-fail'), '');
    const r = update('v1.1.0');
    expect(r.status.state).toBe('rolled_back');
    expect(r.legacyDb).toBe('ORIGINAL\n');
    expect(fs.existsSync(path.join(installDir, 'data', 'dementia.db'))).toBe(false);
    expect(r.log).toContain('БД восстановлена из резервной копии demension.db.');
  });

  it('успешное обновление с версии, где БД называлась demension.db', () => {
    fs.renameSync(path.join(installDir, 'data', 'dementia.db'), path.join(installDir, 'data', 'demension.db'));
    const r = update('v1.1.0');
    expect(r.status.state).toBe('success');
    expect(r.db).toBe('migrated by v1.1.0\n');
    expect(r.legacyDb).toBe('');
  });

  it('версия не формата vX.Y.Z не принимается', () => {
    const r = update('main;touch pwned');
    expect(r.code).toBe(2);
    expect(r.status).toBeNull();
    expect(r.head).toBe(rev['v1.0.0']);
  });
});
