import fs from 'node:fs';
import path from 'node:path';

/**
 * Каталог данных панели (БД, сертификаты, ключ шифрования).
 * По умолчанию ./data относительно рабочего каталога; можно переопределить DEMENSION_DATA_DIR.
 */
export const dataDir = path.resolve(process.env.DEMENSION_DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const sslDir = path.join(dataDir, 'ssl');
fs.mkdirSync(sslDir, { recursive: true, mode: 0o700 });
