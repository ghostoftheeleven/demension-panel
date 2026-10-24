import crypto from 'node:crypto';
import { db, transaction } from '../db/index.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Сколько помнится IP, с которого администратор входил (исключение из блокировки по логину) */
const KNOWN_IP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  /**
   * Hash a plain-text password using native crypto.scryptSync
   */
  static hashPassword(password: string, customSalt?: string): { hash: string; salt: string } {
    const salt = customSalt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
  }

  /**
   * Verify a password against a stored hash and salt
   */
  static verifyPassword(password: string, hash: string, salt: string): boolean {
    const computed = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
  }

  /**
   * Ensure an admin exists. Uses PANEL_USER / PANEL_PASSWORD when provided,
   * otherwise generates a random password and prints it once.
   */
  static ensureDefaultAdmin(username?: string, password?: string): void {
    const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get() as { count: number };
    if (adminCount.count > 0) return;

    const user = username || 'admin';
    const generated = !password;
    const pass = password || crypto.randomBytes(12).toString('base64url');
    const { hash, salt } = this.hashPassword(pass);
    db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)').run(user, hash, salt);

    if (generated) {
      console.log('==================================================================');
      console.log(`[AUTH] Создан администратор "${user}" со случайным паролем: ${pass}`);
      console.log('[AUTH] Сохраните его и смените после входа. Больше он показан не будет.');
      console.log('==================================================================');
    } else {
      console.log(`[AUTH] Создан администратор "${user}" (пароль из PANEL_PASSWORD)`);
    }
  }

  /**
   * Set credentials of the (first) admin, creating it if needed; drops all sessions
   */
  static resetAdmin(username: string, password: string): void {
    const { hash, salt } = this.hashPassword(password);
    transaction(() => {
      const admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get() as { id: number } | undefined;
      if (admin) {
        db.prepare('UPDATE admins SET username = ?, password_hash = ?, salt = ? WHERE id = ?').run(username, hash, salt, admin.id);
      } else {
        db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)').run(username, hash, salt);
      }
      db.exec('DELETE FROM sessions');
      db.exec('DELETE FROM trusted_login_ips');
    });
  }

  /**
   * Запомнить IP успешного входа: блокировка по логину (защита от распределённого перебора) на него не действует,
   * иначе любой мог бы закрыть администратору вход, отправив 10 неверных паролей.
   */
  static rememberLoginIp(ip: string): void {
    db.prepare(`
      INSERT INTO trusted_login_ips (ip, last_login_at) VALUES (?, ?)
      ON CONFLICT(ip) DO UPDATE SET last_login_at = excluded.last_login_at
    `).run(ip, new Date().toISOString());
  }

  static isKnownLoginIp(ip: string): boolean {
    const row = db.prepare('SELECT last_login_at FROM trusted_login_ips WHERE ip = ?').get(ip) as { last_login_at: string } | undefined;
    return Boolean(row) && Date.now() - new Date(row!.last_login_at).getTime() < KNOWN_IP_TTL_MS;
  }

  private static createSession(adminId: number): string {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), adminId, expiresAt);
    return token;
  }

  /**
   * Authenticate admin and generate a session token
   */
  static login(username: string, password: string): { token: string; user: { id: number; username: string } } | null {
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as any;
    if (!admin) {
      // Выравнивание времени ответа, чтобы нельзя было перебирать логины
      this.hashPassword(password);
      return null;
    }

    if (!this.verifyPassword(password, admin.password_hash, admin.salt)) return null;

    return {
      token: this.createSession(admin.id),
      user: { id: admin.id, username: admin.username },
    };
  }

  /**
   * Validate session token
   */
  static validateSession(token: string): { id: number; username: string } | null {
    if (!token) return null;

    const session = db.prepare(`
      SELECT s.admin_id, a.username
      FROM sessions s
      JOIN admins a ON s.admin_id = a.id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(hashToken(token), new Date().toISOString()) as any;

    if (!session) return null;
    return { id: session.admin_id, username: session.username };
  }

  /**
   * Destroy session
   */
  static logout(token: string): void {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
  }

  static cleanupExpiredSessions(): void {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
    db.prepare('DELETE FROM trusted_login_ips WHERE last_login_at <= ?').run(new Date(Date.now() - KNOWN_IP_TTL_MS).toISOString());
  }

  /**
   * Change admin password. All sessions are revoked; a fresh token for the caller is returned.
   */
  static changePassword(adminId: number, oldPass: string, newPass: string): string | null {
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId) as any;
    if (!admin) return null;

    if (!this.verifyPassword(oldPass, admin.password_hash, admin.salt)) {
      return null;
    }

    const { hash, salt } = this.hashPassword(newPass);
    return transaction(() => {
      db.prepare('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, adminId);
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
      return this.createSession(adminId);
    });
  }
}
