import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Fail2banStatus {
  installed: boolean;
  active: boolean;
  jail: string;
  totalFailed: number;
  totalBanned: number;
  currentlyBanned: string[];
  maxRetry: number;
  banTime: number;
  findTime: number;
}

const DEFAULTS = { jail: 'sshd', maxRetry: 4, banTime: 86400, findTime: 600 };

function emptyStatus(installed: boolean): Fail2banStatus {
  return { installed, active: false, totalFailed: 0, totalBanned: 0, currentlyBanned: [], ...DEFAULTS };
}

function validateIp(ip: unknown): string {
  const clean = typeof ip === 'string' ? ip.trim() : '';
  if (!net.isIP(clean)) {
    throw new Error('Некорректный IP-адрес');
  }
  return clean;
}

export class Fail2banService {
  /**
   * Get Fail2ban status and list of banned IPs for sshd jail
   */
  static async getStatus(): Promise<Fail2banStatus> {
    if (process.platform === 'win32') return emptyStatus(false);

    try {
      await execFileAsync('fail2ban-client', ['--version']);
    } catch {
      return emptyStatus(false);
    }

    try {
      const { stdout } = await execFileAsync('fail2ban-client', ['status', 'sshd']);

      const failedMatch = stdout.match(/Total failed:\s+(\d+)/);
      const totalBannedMatch = stdout.match(/Total banned:\s+(\d+)/);
      const bannedListMatch = stdout.match(/Banned IP list:[ \t]*(.*)/);

      return {
        ...DEFAULTS,
        installed: true,
        active: true,
        totalFailed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
        totalBanned: totalBannedMatch ? parseInt(totalBannedMatch[1], 10) : 0,
        currentlyBanned: bannedListMatch ? bannedListMatch[1].trim().split(/\s+/).filter(Boolean) : [],
      };
    } catch {
      // fail2ban установлен, но служба или jail sshd не запущены
      return emptyStatus(true);
    }
  }

  /**
   * Unban an IP address
   */
  static async unbanIp(ip: unknown): Promise<{ success: boolean; message: string }> {
    const cleanIp = validateIp(ip);
    try {
      await execFileAsync('fail2ban-client', ['set', 'sshd', 'unbanip', cleanIp]);
      return { success: true, message: `IP ${cleanIp} успешно разблокирован` };
    } catch (err: any) {
      throw new Error(`Ошибка разблокировки: ${err.stderr?.trim() || err.message}`);
    }
  }

  /**
   * Manually ban an IP address
   */
  static async banIp(ip: unknown): Promise<{ success: boolean; message: string }> {
    const cleanIp = validateIp(ip);
    try {
      await execFileAsync('fail2ban-client', ['set', 'sshd', 'banip', cleanIp]);
      return { success: true, message: `IP ${cleanIp} заблокирован в fail2ban` };
    } catch (err: any) {
      throw new Error(`Ошибка блокировки: ${err.stderr?.trim() || err.message}`);
    }
  }

  /**
   * Install and configure Fail2ban with strict SSH protection rules
   */
  static async setupLocal(): Promise<{ success: boolean; message: string }> {
    if (process.platform === 'win32') {
      return { success: false, message: 'Fail2ban доступен только на Linux-серверах' };
    }

    // Скрипт фиксированный, пользовательские данные в него не подставляются
    const script = `
      set -e
      if ! command -v fail2ban-client >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
          apt-get update -y && apt-get install -y fail2ban
        elif command -v dnf >/dev/null 2>&1; then
          dnf install -y epel-release || true
          dnf install -y fail2ban
        fi
      fi

      SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)
      SSH_PORT=\${SSH_PORT:-ssh}
      if [ -f /var/log/auth.log ] || [ -f /var/log/secure ]; then BACKEND=auto; else BACKEND=systemd; fi

      mkdir -p /etc/fail2ban/jail.d
      rm -f /etc/fail2ban/jail.d/demension-sshd.local
      cat > /etc/fail2ban/jail.d/dementia-sshd.local <<EOF
[sshd]
enabled = true
port = \${SSH_PORT}
filter = sshd
backend = \${BACKEND}
maxretry = 4
findtime = 600
bantime = 86400
EOF

      systemctl enable fail2ban
      systemctl restart fail2ban
    `;

    try {
      await execFileAsync('bash', ['-c', script], { timeout: 10 * 60 * 1000 });
      return { success: true, message: 'Fail2ban успешно установлен и настроен (sshd jail активен)!' };
    } catch (err: any) {
      throw new Error(`Ошибка настройки Fail2ban: ${err.stderr?.trim() || err.message}`);
    }
  }
}
