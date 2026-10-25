import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptLegacyDatabase } from '../src/config.js';
import { panelEnv } from '../src/utils/env.js';

/**
 * Проект переименован Demension → Dementia (v0.1.4). Уже работающие панели должны продолжить работать: прежний файл БД
 * подхватывается, переменные окружения со старыми именами читаются.
 */
describe('совместимость с прежним именем проекта (Demension)', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-rename-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.DEMENTIA_UPDATE_CHECK;
    delete process.env.DEMENSION_UPDATE_CHECK;
  });

  it('demension.db с журналом WAL переименовывается в dementia.db', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'demension.db'), 'db');
    fs.writeFileSync(path.join(dir, 'demension.db-wal'), 'wal');
    adoptLegacyDatabase(dir);
    expect(fs.readFileSync(path.join(dir, 'dementia.db'), 'utf-8')).toBe('db');
    expect(fs.readFileSync(path.join(dir, 'dementia.db-wal'), 'utf-8')).toBe('wal');
    expect(fs.existsSync(path.join(dir, 'demension.db'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'demension.db-wal'))).toBe(false);
  });

  it('без прежнего файла ничего не меняется', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'dementia.db'), 'current');
    adoptLegacyDatabase(dir);
    expect(fs.readFileSync(path.join(dir, 'dementia.db'), 'utf-8')).toBe('current');
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('есть оба файла (откат на версию до переименования): прежний побеждает, новый уходит в backups', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'dementia.db'), 'stale');
    fs.writeFileSync(path.join(dir, 'demension.db'), 'after-rollback');
    adoptLegacyDatabase(dir);
    expect(fs.readFileSync(path.join(dir, 'dementia.db'), 'utf-8')).toBe('after-rollback');
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^dementia\.db\.superseded-/);
    expect(fs.readFileSync(path.join(dir, 'backups', backups[0]), 'utf-8')).toBe('stale');
  });

  it('переменные окружения: DEMENTIA_* важнее, DEMENSION_* — запасной вариант', () => {
    expect(panelEnv('UPDATE_CHECK')).toBeUndefined();
    process.env.DEMENSION_UPDATE_CHECK = '0';
    expect(panelEnv('UPDATE_CHECK')).toBe('0');
    process.env.DEMENTIA_UPDATE_CHECK = '1';
    expect(panelEnv('UPDATE_CHECK')).toBe('1');
  });
});
