// Сравнение двух выгрузок dump-db.mjs после обновления панели: каждая строка каждой прежней таблицы должна сохраниться без
// изменений (новые колонки и новые таблицы допустимы). Использование: node compare-dumps.mjs до.json после.json [таблица…]
// Таблицы после аргументов пропускаются.
import fs from 'node:fs';

const [beforeFile, afterFile, ...skip] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
const problems = [];
let rows = 0;

for (const [table, beforeRows] of Object.entries(before)) {
  if (table === '__user_version' || skip.includes(table)) continue;
  const afterRows = after[table];
  if (!afterRows) {
    problems.push(`таблицы ${table} больше нет`);
    continue;
  }
  if (afterRows.length !== beforeRows.length) problems.push(`${table}: было ${beforeRows.length} строк, стало ${afterRows.length}`);
  beforeRows.forEach((row, index) => {
    rows++;
    for (const [column, value] of Object.entries(row)) {
      if (JSON.stringify(afterRows[index]?.[column]) !== JSON.stringify(value)) {
        problems.push(`${table}[${index}].${column}: «${value}» → «${afterRows[index]?.[column]}»`);
      }
    }
  });
}

console.log(`проверено строк: ${rows}; версия схемы ${before.__user_version} → ${after.__user_version}`);
if (problems.length) {
  console.log(problems.slice(0, 20).join('\n'));
  process.exit(1);
}
