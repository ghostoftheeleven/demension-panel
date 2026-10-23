import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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

export class Fail2banService {
  /**
   * Get Fail2ban status and list of banned IPs for sshd jail
   */
  static async getStatus(): Promise<Fail2banStatus> {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      return {
        installed: false,
        active: false,
        jail: 'sshd',
        totalFailed: 0,
        totalBanned: 0,
        currentlyBanned: [],
        maxRetry: 4,
        banTime: 86400,
        findTime: 600,
      };
    }

    try {
      // Check if installed
      await execAsync('which fail2ban-client');
    } catch {
      return {
        installed: false,
        active: false,
        jail: 'sshd',
        totalFailed: 0,
        totalBanned: 0,
        currentlyBanned: [],
        maxRetry: 4,
        banTime: 86400,
        findTime: 600,
      };
    }

    try {
      const { stdout } = await execAsync('fail2ban-client status sshd 2>/dev/null || true');

      let totalFailed = 0;
      let totalBanned = 0;
      let currentlyBanned: string[] = [];

      const failedMatch = stdout.match(/Total failed:\s+(\d+)/);
      if (failedMatch) totalFailed = parseInt(failedMatch[1], 10);

      const totalBannedMatch = stdout.match(/Total banned:\s+(\d+)/);
      if (totalBannedMatch) totalBanned = parseInt(totalBannedMatch[1], 10);

      const bannedListMatch = stdout.match(/Banned IP list:\s+(.*)/);
      if (bannedListMatch && bannedListMatch[1].trim().length > 0) {
        currentlyBanned = bannedListMatch[1].trim().split(/\s+/).filter(Boolean);
      }

      return {
        installed: true,
        active: true,
        jail: 'sshd',
        totalFailed,
        totalBanned,
        currentlyBanned,
        maxRetry: 4,
        banTime: 86400,
        findTime: 600,
      };
    } catch {
      return {
        installed: true,
        active: false,
        jail: 'sshd',
        totalFailed: 0,
        totalBanned: 0,
        currentlyBanned: [],
        maxRetry: 4,
        banTime: 86400,
        findTime: 600,
      };
    }
  }

  /**
   * Unban an IP address
   */
  static async unbanIp(ip: string): Promise<{ success: boolean; message: string }> {
    try {
      const cleanIp = ip.trim();
      await execAsync(`fail2ban-client set sshd unbanip ${cleanIp}`);
      return { success: true, message: `IP ${cleanIp} успешно разблокирован` };
    } catch (err: any) {
      throw new Error(`Ошибка разблокировки: ${err.message}`);
    }
  }

  /**
   * Manually ban an IP address
   */
  static async banIp(ip: string): Promise<{ success: boolean; message: string }> {
    try {
      const cleanIp = ip.trim();
      await execAsync(`fail2ban-client set sshd banip ${cleanIp}`);
      return { success: true, message: `IP ${cleanIp} заблокирован в fail2ban` };
    } catch (err: any) {
      throw new Error(`Ошибка блокировки: ${err.message}`);
    }
  }

  /**
   * Install and configure Fail2ban with strict SSH protection rules
   */
  static async setupLocal(): Promise<{ success: boolean; message: string }> {
    if (process.platform === 'win32') {
      return { success: false, message: 'Fail2ban доступен только на Linux-серверах' };
    }

    try {
      const script = `
        if command -v apt-get >/dev/null 2>&1; then
          apt-get update -y && apt-get install -y fail2ban
        elif command -v dnf >/dev/null 2>&1; then
          dnf install -y fail2ban
        fi

        mkdir -p /etc/fail2ban/jail.d
        cat > /etc/fail2ban/jail.d/demension-sshd.local <<EOF
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 4
findtime = 600
bantime = 86400
action = iptables[name=SSH, port=ssh, protocol=tcp]
EOF

        systemctl enable fail2ban
        systemctl restart fail2ban
      `;

      await execAsync(script);
      return { success: true, message: 'Fail2ban успешно установлен и настроен (sshd jail активен)!' };
    } catch (err: any) {
      throw new Error(`Ошибка настройки Fail2ban: ${err.message}`);
    }
  }
}
