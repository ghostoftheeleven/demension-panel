import fs from 'node:fs';
import { importPanelArchive } from '../services/migration-import.service.js';

async function main(): Promise<void> {
  const [file, encodedKey] = process.argv.slice(2);
  if (!file || !encodedKey) throw new Error('Использование: node server/dist/cli/restore-backup.js <архив> <ключ>');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) throw new Error('Ключ восстановления должен содержать 32 байта в base64');
  const archive = fs.readFileSync(file);
  const result = await importPanelArchive(archive, key, { replace: true, backupPrefix: 'pre-backup' });
  console.log(`Резервная копия от ${result.manifest.createdAt} восстановлена.`);
  if (result.backupDir) console.log(`Прежние данные сохранены: ${result.backupDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'Не удалось восстановить резервную копию');
  process.exitCode = 1;
});
