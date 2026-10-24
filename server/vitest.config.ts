import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Все тесты используют одну временную БД — выполняем последовательно
    fileParallelism: false,
  },
});
