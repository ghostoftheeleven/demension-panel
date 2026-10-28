import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db/index.js';
import { decryptSecret, encryptSecret } from './secrets.service.js';
import { PanelArchiveService } from './panel-archive.service.js';
import { BackupStorage, GoogleDriveStorage, YandexDiskStorage } from './backup-storage.js';
import { MigrationService } from './migration.service.js';
import { EventService } from './event.service.js';

export type BackupProvider = 'yandex' | 'google';
export interface BackupSettings {
  enabled: boolean;
  provider: BackupProvider;
  interval_hours: number;
  retention: number;
  yandex_username: string;
  yandex_password_saved: boolean;
  google_client_id: string;
  google_client_secret_saved: boolean;
  google_refresh_token_saved: boolean;
  google_folder_id: string;
  last_run: string | null;
  last_error: string | null;
}

export class BackupService {
  private static running = false;

  static getSettings(): BackupSettings {
    return {
      enabled: getSetting('backup_enabled') === '1',
      provider: getSetting('backup_provider') === 'google' ? 'google' : 'yandex',
      interval_hours: Number(getSetting('backup_interval_hours')) || 24,
      retention: Number(getSetting('backup_retention')) || 10,
      yandex_username: getSetting('backup_yandex_username') ?? '',
      yandex_password_saved: Boolean(getSetting('backup_yandex_password')),
      google_client_id: getSetting('backup_google_client_id') ?? '',
      google_client_secret_saved: Boolean(getSetting('backup_google_client_secret')),
      google_refresh_token_saved: Boolean(getSetting('backup_google_refresh_token')),
      google_folder_id: getSetting('backup_google_folder_id') ?? '',
      last_run: getSetting('backup_last_run'),
      last_error: getSetting('backup_last_error'),
    };
  }

  static recoveryKey(): string {
    const existing = decryptSecret(getSetting('backup_recovery_key'));
    if (existing && Buffer.from(existing, 'base64').length === 32) return existing;
    const created = crypto.randomBytes(32).toString('base64');
    setSetting('backup_recovery_key', encryptSecret(created));
    return created;
  }

  static async runNow(): Promise<{ success: boolean; error?: string }> {
    if (this.running) return { success: false, error: 'Резервное копирование уже выполняется' };
    if (MigrationService.isBackgroundPaused()) return { success: false, error: 'Копирование недоступно во время переноса панели' };
    this.running = true;
    try {
      const archive = PanelArchiveService.create(Buffer.from(this.recoveryKey(), 'base64'));
      const name = `dementia-${new Date().toISOString().replace(/[:.]/g, '-')}.dpm`;
      const storage = this.getStorage();
      await storage.upload(name, archive);
      await this.prune(storage, this.getSettings().retention);
      setSetting('backup_last_run', new Date().toISOString());
      setSetting('backup_last_error', null);
      EventService.log('info', 'backup.created', `Резервная копия «${name}» загружена во внешнее хранилище`);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : 'Неизвестная ошибка';
      setSetting('backup_last_error', message);
      EventService.log('error', 'backup.failed', `Не удалось создать резервную копию: ${message}`);
      return { success: false, error: message };
    } finally {
      this.running = false;
    }
  }

  static async runIfDue(): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.enabled || MigrationService.isBackgroundPaused() || this.running) return false;
    const last = settings.last_run ? Date.parse(settings.last_run) : 0;
    if (Date.now() - last < settings.interval_hours * 3600000) return false;
    await this.runNow();
    return true;
  }

  static async prune(storage: BackupStorage, retention: number): Promise<void> {
    const files = await storage.list();
    const sorted = files.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    for (const file of sorted.slice(retention)) await storage.delete(file.id);
  }

  private static getStorage(): BackupStorage {
    const settings = this.getSettings();
    if (settings.provider === 'google') {
      const clientSecret = decryptSecret(getSetting('backup_google_client_secret'));
      const refreshToken = decryptSecret(getSetting('backup_google_refresh_token'));
      if (!settings.google_client_id || !clientSecret || !refreshToken) throw new Error('Заполните настройки Google OAuth');
      return new GoogleDriveStorage({ client_id: settings.google_client_id, client_secret: clientSecret, refresh_token: refreshToken, folder_id: settings.google_folder_id });
    }
    const password = decryptSecret(getSetting('backup_yandex_password'));
    if (!settings.yandex_username || !password) throw new Error('Укажите логин и пароль приложения Яндекс Диска');
    return new YandexDiskStorage({ username: settings.yandex_username, password });
  }

  static async testStorage(): Promise<void> { await this.getStorage().test(); }
  static async list() { return this.getStorage().list(); }
  static async download(id: string) { return this.getStorage().download(id); }
  static async delete(id: string) { await this.getStorage().delete(id); }
}
