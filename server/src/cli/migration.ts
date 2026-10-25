/**
 * Перенос панели на другой сервер из командной строки (его вызывает install.sh в режиме переноса, docs/migration.md).
 * Код переноса и токен Cloudflare передаются через окружение, чтобы не попадать в список процессов.
 *
 * Новый сервер (до запуска службы):
 *   MIGRATION_CODE=… node dist/cli/migration.js pull --from https://old.example.com:3001 [--replace]
 *   MIGRATION_CODE=… node dist/cli/migration.js file --path /root/dementia-migration.dpm [--replace]
 *   node dist/cli/migration.js dns-check --domain panel.example.com
 *   node dist/cli/migration.js ssl --mode keep|cf|http|ip|custom|none [--domain d] [--email e] [--ip x] [--cert f --key f] [--a-record yes|no]
 *   node dist/cli/migration.js url --host panel.example.com --port 3001 [--scheme https]
 *   MIGRATION_CODE=… node dist/cli/migration.js finish --from https://old.example.com:3001 --new-url https://panel.example.com:3001
 * Прежний сервер:
 *   node dist/cli/migration.js resume     снять блокировку/заморозку, если перенос не удался или отменён
 *
 * Для скриптов результат печатается строками `@@ключ=значение`; ошибки — в stderr, код возврата 1 (неверные аргументы — 2;
 * 3 — на этом сервере уже есть панель с данными, нужен --replace).
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { downloadMigrationArchive, notifyMigrationFinished } from '../services/migration-client.js';
import { importMigrationArchive } from '../services/migration-import.service.js';
import { ExistingDataError, MigrationArchiveError } from '../utils/migration-archive.js';

class UsageError extends Error {}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = '', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new UsageError(`Неожиданный аргумент: ${arg}`);
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = '1';
    else {
      flags[name] = next;
      i++;
    }
  }
  return { command, flags };
}

/** Значение для скрипта: без управляющих символов, в одну строку */
const out = (key: string, value: string | number | boolean | null | undefined) => {
  const text = value === null || value === undefined ? '' : String(value === true ? 1 : value === false ? 0 : value);
  console.log(`@@${key}=${text.replace(/[\x00-\x1f\x7f]/g, ' ').trim()}`);
};

function requireFlag(flags: Record<string, string>, name: string): string {
  if (!flags[name] || flags[name] === '1') throw new UsageError(`Не указан параметр --${name}`);
  return flags[name];
}

function requireCode(): string {
  const code = process.env.MIGRATION_CODE;
  if (!code) throw new UsageError('Не задан код переноса (переменная окружения MIGRATION_CODE)');
  return code;
}

async function reportImport(archive: Buffer, flags: Record<string, string>): Promise<void> {
  const { manifest, backupDir } = await importMigrationArchive(archive, requireCode(), { replace: Boolean(flags.replace) });
  console.log(
    `Данные прежней панели (${manifest.panelVersion}) перенесены: серверов ${manifest.counts.servers}` +
      (manifest.counts.remoteServers ? ` (+${manifest.counts.remoteServers} нод партнёров)` : '') +
      `, клиентов ${manifest.counts.clients}, пользователей ${manifest.counts.subscribers}, партнёров ${manifest.counts.partners}.`
  );

  // Сертификат прежней панели можно оставить, если он читается и не истёк
  let certOk = false;
  if (manifest.ssl.hasFiles) {
    try {
      const { certPath } = await import('../services/ssl.service.js');
      certOk = new Date(new crypto.X509Certificate(fs.readFileSync(certPath)).validTo).getTime() > Date.now();
    } catch {
      certOk = false;
    }
  }

  out('old_version', manifest.panelVersion);
  out('old_admin', manifest.adminUsername);
  out('old_port', manifest.port);
  out('servers', manifest.counts.servers);
  out('clients', manifest.counts.clients);
  out('subscribers', manifest.counts.subscribers);
  out('ssl_cert_ok', manifest.ssl.enabled && certOk);
  out('ssl_domain', manifest.ssl.domain);
  out('ssl_mode', manifest.ssl.mode);
  out('ssl_expires', manifest.ssl.expiresAt?.slice(0, 10));
  out('ssl_email', manifest.sslEmail);
  out('cf_token_saved', manifest.cloudflareTokenSaved);
  out('public_url_set', Boolean(manifest.publicUrl));
  out('backup_dir', backupDir);
}

async function cmdSsl(flags: Record<string, string>): Promise<void> {
  const { initDatabase, getSetting } = await import('../db/index.js');
  const { SslService } = await import('../services/ssl.service.js');
  const { detectPublicIpv4 } = await import('../utils/net.js');
  initDatabase();

  const mode = requireFlag(flags, 'mode');
  const email = () => flags.email || getSetting('ssl_email') || '';

  switch (mode) {
    case 'keep': {
      const { domain, expiresAt } = SslService.activateExisting();
      console.log(`Сертификат прежней панели сохранён (${domain}, до ${expiresAt.slice(0, 10)}).`);
      break;
    }
    case 'cf': {
      const token = process.env.CF_API_TOKEN || SslService.getSavedCloudflareToken();
      if (!token) throw new UsageError('Нет токена Cloudflare: передайте его переменной CF_API_TOKEN');
      const domain = requireFlag(flags, 'domain');
      if (!email()) throw new UsageError('Не указан email для Let\'s Encrypt (--email)');
      console.log(`Выпуск сертификата Let's Encrypt для ${domain} через Cloudflare (DNS-проверка, около минуты)...`);
      await SslService.issueLetsEncryptCloudflare(domain, email(), token, flags['a-record'] !== 'no');
      break;
    }
    case 'http': {
      const domain = requireFlag(flags, 'domain');
      if (!email()) throw new UsageError('Не указан email для Let\'s Encrypt (--email)');
      console.log(`Выпуск сертификата Let's Encrypt для ${domain} (HTTP-проверка на порту 80)...`);
      await SslService.issueLetsEncryptHttp(domain, email());
      break;
    }
    case 'ip': {
      const ip = flags.ip || (await detectPublicIpv4());
      if (!ip) throw new UsageError('Не удалось определить внешний IP сервера: укажите его параметром --ip');
      await SslService.generateSelfSignedIpCert(ip);
      console.log(`Самоподписанный сертификат для ${ip} создан.`);
      break;
    }
    case 'custom': {
      const certFile = requireFlag(flags, 'cert');
      const keyFile = requireFlag(flags, 'key');
      let cert: string;
      let key: string;
      try {
        cert = fs.readFileSync(certFile, 'utf-8');
        key = fs.readFileSync(keyFile, 'utf-8');
      } catch (err: any) {
        throw new UsageError(`Не удалось прочитать файл: ${err.path ?? ''} (${err.code ?? err.message})`);
      }
      SslService.saveCustomCertificate(cert, key, flags.domain);
      console.log('Сертификат с этого сервера установлен (автопродление для него недоступно).');
      break;
    }
    case 'none':
      SslService.clearCertificate();
      console.log('HTTPS отключён: включить его можно позже в разделе «Безопасность».');
      break;
    default:
      throw new UsageError(`Неизвестный режим сертификата: ${mode}`);
  }

  const status = SslService.getStatus();
  out('ssl_mode', status.mode);
  out('ssl_domain', status.domain);
  out('ssl_enabled', status.enabled);
  out('ssl_expires', status.expiresAt?.slice(0, 10));
}

async function cmdDnsCheck(flags: Record<string, string>): Promise<void> {
  const domain = requireFlag(flags, 'domain');
  const { detectPublicIpv4 } = await import('../utils/net.js');
  const [resolved, publicIp] = await Promise.all([dns.resolve4(domain).catch(() => [] as string[]), detectPublicIpv4()]);
  out('dns_resolved', resolved.join(','));
  out('public_ip', publicIp);
  out('dns_ok', Boolean(publicIp) && resolved.includes(publicIp!));
}

async function cmdUrl(flags: Record<string, string>): Promise<void> {
  const { initDatabase, getSetting, setSetting } = await import('../db/index.js');
  const { SslService } = await import('../services/ssl.service.js');
  const { formatEndpointHost } = await import('../utils/net.js');
  initDatabase();

  const host = requireFlag(flags, 'host');
  const port = Number(requireFlag(flags, 'port'));
  const scheme = flags.scheme || (SslService.isActive() ? 'https' : 'http');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (scheme !== 'http' && scheme !== 'https')) throw new UsageError('Некорректный порт или схема');

  const defaultPort = scheme === 'https' ? 443 : 80;
  const url = `${scheme}://${formatEndpointHost(host)}${port === defaultPort ? '' : `:${port}`}`;
  // Явно заданный публичный адрес относился к прежнему серверу — ссылки подписок должны строиться от нового
  if (getSetting('public_url')) {
    setSetting('public_url', url);
    console.log(`Публичный адрес панели в настройках обновлён: ${url}`);
  }
  out('new_url', url);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'pull': {
      const code = requireCode();
      const from = requireFlag(flags, 'from');
      console.log(`Получение данных с прежней панели ${from}...`);
      const { archive, insecureTls } = await downloadMigrationArchive(from, code);
      if (insecureTls) console.log('Сертификат прежней панели не прошёл проверку (самоподписанный?); данные зашифрованы кодом переноса, перенос продолжается.');
      await reportImport(archive, flags);
      break;
    }
    case 'file': {
      const file = requireFlag(flags, 'path');
      let archive: Buffer;
      try {
        archive = fs.readFileSync(file);
      } catch (err: any) {
        throw new UsageError(`Не удалось прочитать файл архива ${file}: ${err.code ?? err.message}`);
      }
      await reportImport(archive, flags);
      break;
    }
    case 'dns-check':
      await cmdDnsCheck(flags);
      break;
    case 'ssl':
      await cmdSsl(flags);
      break;
    case 'url':
      await cmdUrl(flags);
      break;
    case 'finish':
      // Без нового адреса ссылки подписок прежней панели не перенаправляются
      await notifyMigrationFinished(requireFlag(flags, 'from'), requireCode(), flags['new-url'] && flags['new-url'] !== '1' ? flags['new-url'] : '');
      console.log('Прежняя панель уведомлена: она заморожена, а её ссылки подписок перенаправляются на новый адрес.');
      break;
    case 'resume': {
      const { initDatabase } = await import('../db/index.js');
      const { MigrationService } = await import('../services/migration.service.js');
      initDatabase();
      MigrationService.cancel();
      console.log('Состояние переноса сброшено: панель работает в обычном режиме. Перезапустите службу: systemctl restart dementia');
      break;
    }
    default:
      throw new UsageError(`Неизвестная команда «${command}». Команды: pull, file, dns-check, ssl, url, finish, resume`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    if (err instanceof UsageError) {
      console.error(`Ошибка: ${err.message}`);
      process.exit(2);
    }
    console.error(`Ошибка: ${err instanceof MigrationArchiveError || err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof ExistingDataError ? 3 : 1);
  }
);
