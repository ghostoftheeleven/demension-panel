import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Изолированный каталог данных для каждого прогона тестов
process.env.DEMENTIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dementia-test-'));
