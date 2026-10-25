// Содержимое всех таблиц БД панели в JSON (только чтение): node dump-db.mjs путь/к/demension.db > файл.json
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);
const dump = {};
for (const table of tables) dump[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
dump.__user_version = db.prepare('PRAGMA user_version').get().user_version;
console.log(JSON.stringify(dump));
