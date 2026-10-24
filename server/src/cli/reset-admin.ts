/**
 * Установка логина и пароля администратора из командной строки.
 * Пароль передаётся через переменную окружения, чтобы не светиться в списке процессов:
 *
 *   PANEL_USER=admin PANEL_PASSWORD='...' node dist/cli/reset-admin.js
 */
import { initDatabase } from '../db/index.js';
import { AuthService, MIN_PASSWORD_LENGTH } from '../services/auth.service.js';

const username = process.env.PANEL_USER || 'admin';
const password = process.env.PANEL_PASSWORD || '';

if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов (переменная PANEL_PASSWORD)`);
  process.exit(1);
}

initDatabase();
AuthService.resetAdmin(username, password);
console.log(`Учётные данные администратора "${username}" обновлены, все сессии завершены.`);
console.log('Если вход заблокирован из-за неудачных попыток, счётчики сбросятся после перезапуска службы: systemctl restart demension');
