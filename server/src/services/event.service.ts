import { db } from '../db/index.js';
import { TelegramService } from './telegram.service.js';

export type EventLevel = 'info' | 'warning' | 'error';

export interface PanelEvent {
  id?: number;
  level: EventLevel;
  type: string;
  message: string;
  entity_kind?: string | null;
  entity_id?: string | null;
  created_at?: string;
}

export class EventService {
  static log(level: EventLevel, type: string, message: string, entity?: { kind: string; id: number | string }): void {
    db.prepare('INSERT INTO events(level, type, message, entity_kind, entity_id) VALUES (?, ?, ?, ?, ?)').run(
      level,
      type.slice(0, 100),
      message.slice(0, 2000),
      entity?.kind.slice(0, 50) ?? null,
      entity ? String(entity.id).slice(0, 100) : null,
    );
    db.prepare('DELETE FROM events WHERE id < (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 4999)').run();
    void TelegramService.deliverEvent({ level, type, message });
  }

  static list(options: { level?: EventLevel; limit?: number; offset?: number }): { items: PanelEvent[]; total: number } {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 100000);
    const where = options.level ? 'WHERE level = ?' : '';
    const params = options.level ? [options.level] : [];
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM events ${where}`).get(...params) as { c: number }).c;
    const items = db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as PanelEvent[];
    return { items, total };
  }
}
