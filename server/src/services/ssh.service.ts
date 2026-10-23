import { Client, ConnectConfig } from 'ssh2';

export interface SshCredentials {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
}

export class SshService {
  /**
   * Test SSH connection
   */
  static async testConnection(credentials: SshCredentials): Promise<{ success: boolean; message?: string }> {
    return new Promise((resolve) => {
      const conn = new Client();
      const config: ConnectConfig = {
        host: credentials.host,
        port: credentials.port || 22,
        username: credentials.username || 'root',
        readyTimeout: 10000,
      };

      if (credentials.privateKey && credentials.privateKey.trim().length > 0) {
        config.privateKey = credentials.privateKey;
      } else if (credentials.password) {
        config.password = credentials.password;
      }

      conn
        .on('ready', () => {
          conn.end();
          resolve({ success: true, message: 'Подключение успешно установлено!' });
        })
        .on('error', (err) => {
          resolve({ success: false, message: `Ошибка подключения: ${err.message}` });
        })
        .connect(config);
    });
  }

  /**
   * Execute command on remote host with streaming stdout/stderr
   */
  static async executeCommand(
    credentials: SshCredentials,
    command: string,
    onData?: (chunk: string) => void
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let stdout = '';
      let stderr = '';

      const config: ConnectConfig = {
        host: credentials.host,
        port: credentials.port || 22,
        username: credentials.username || 'root',
        readyTimeout: 15000,
      };

      if (credentials.privateKey && credentials.privateKey.trim().length > 0) {
        config.privateKey = credentials.privateKey;
      } else if (credentials.password) {
        config.password = credentials.password;
      }

      conn
        .on('ready', () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              conn.end();
              return reject(err);
            }

            stream
              .on('close', (code: number) => {
                conn.end();
                resolve({ code, stdout, stderr });
              })
              .on('data', (data: Buffer) => {
                const text = data.toString('utf-8');
                stdout += text;
                if (onData) onData(text);
              })
              .stderr.on('data', (data: Buffer) => {
                const text = data.toString('utf-8');
                stderr += text;
                if (onData) onData(text);
              });
          });
        })
        .on('error', (err) => {
          reject(err);
        })
        .connect(config);
    });
  }

  /**
   * Upload file content directly via SFTP
   */
  static async uploadContent(
    credentials: SshCredentials,
    remotePath: string,
    content: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const config: ConnectConfig = {
        host: credentials.host,
        port: credentials.port || 22,
        username: credentials.username || 'root',
        readyTimeout: 15000,
      };

      if (credentials.privateKey && credentials.privateKey.trim().length > 0) {
        config.privateKey = credentials.privateKey;
      } else if (credentials.password) {
        config.password = credentials.password;
      }

      conn
        .on('ready', () => {
          conn.sftp((err, sftp) => {
            if (err) {
              conn.end();
              return reject(err);
            }

            const writeStream = sftp.createWriteStream(remotePath);
            writeStream.on('close', () => {
              conn.end();
              resolve();
            });
            writeStream.on('error', (wErr: any) => {
              conn.end();
              reject(wErr);
            });
            writeStream.end(content);
          });
        })
        .on('error', (err) => {
          reject(err);
        })
        .connect(config);
    });
  }
}
