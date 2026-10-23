import crypto from 'node:crypto';
import { db } from '../db/index.js';

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
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  }

  /**
   * Ensure default admin exists if no admins present
   */
  static ensureDefaultAdmin(defaultUser = 'admin', defaultPass = 'admin'): void {
    const adminCount = db.prepare('SELECT COUNT(*) as count FROM admins').get() as { count: number };
    if (adminCount.count === 0) {
      const { hash, salt } = this.hashPassword(defaultPass);
      db.prepare(`
        INSERT INTO admins (username, password_hash, salt)
        VALUES (?, ?, ?)
      `).run(defaultUser, hash, salt);
      console.log(`[AUTH] Создан начальный администратор: ${defaultUser} (пароль: ${defaultPass})`);
    }
  }

  /**
   * Authenticate admin and generate a session token
   */
  static login(username: string, password: string): { token: string; user: { id: number; username: string } } | null {
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as any;
    if (!admin) return null;

    const isValid = this.verifyPassword(password, admin.password_hash, admin.salt);
    if (!isValid) return null;

    // Generate session token valid for 7 days
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO sessions (token, admin_id, expires_at)
      VALUES (?, ?, ?)
    `).run(token, admin.id, expiresAt);

    return {
      token,
      user: { id: admin.id, username: admin.username },
    };
  }

  /**
   * Validate session token
   */
  static validateSession(token: string): { id: number; username: string } | null {
    if (!token) return null;

    const session = db.prepare(`
      SELECT s.*, a.username 
      FROM sessions s
      JOIN admins a ON s.admin_id = a.id
      WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
    `).get(token) as any;

    if (!session) return null;

    return {
      id: session.admin_id,
      username: session.username,
    };
  }

  /**
   * Destroy session
   */
  static logout(token: string): void {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /**
   * Change admin password
   */
  static changePassword(adminId: number, oldPass: string, newPass: string): boolean {
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId) as any;
    if (!admin) return false;

    if (!this.verifyPassword(oldPass, admin.password_hash, admin.salt)) {
      return false;
    }

    const { hash, salt } = this.hashPassword(newPass);
    db.prepare('UPDATE admins SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, adminId);
    return true;
  }
}
