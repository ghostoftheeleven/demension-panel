# Operations Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Выпустить v0.2.5 с обязательными E2E, облачными зашифрованными резервными копиями, событиями/Telegram, 2FA/сессиями и оптимизацией клиента.

**Architecture:** Расширяем существующие Express/React/SQLite-сервисы, не меняя agentless-модель. Общий зашифрованный формат архива используется переносом и резервными копиями; внешние провайдеры изолированы за единым интерфейсом хранилища. События сохраняются в SQLite и асинхронно транслируются в Telegram.

**Tech Stack:** Node.js 22+, TypeScript, Express 4, `node:sqlite`, Node `crypto`/fetch, React 19, Vite 8, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-28-operations-hardening-design.md`

## Global Constraints

- Версия релиза `0.2.5`; повышается только `Z` по `docs/releases.md`.
- Схема меняется только новыми миграциями в конце `migrations`; секреты шифруются, токены/коды восстановления хранятся как SHA-256.
- Новый фоновый цикл проверяет `MigrationService.isBackgroundPaused()`.
- Внешние сетевые вызовы в тестах подменяются; UI — русский, Bento и семантические цвета.
- Готовая работа проверяется стандартными командами сервера, клиента и shellcheck.

## Review Focus

- Потерянный или неверный ключ восстановления: архив не должен открываться, прежние данные не должны быть удалены; проверяется Task 3.
- Недоступность Yandex/Google/Telegram: основная работа панели и VPN не блокируются, ошибка видна администратору; проверяется Tasks 2–3.
- Неверный/повторный TOTP или код восстановления: сессия не выдаётся, одноразовый код нельзя использовать повторно; проверяется Task 4.
- Сотни подписчиков: число SQL-запросов списка не растёт линейно; проверяется Task 5.
- Перенос панели: резервное копирование и Telegram не работают на замороженной панели; проверяется Tasks 2–3.

---

### Task 1: Обязательные проверки и быстрые исправления

**Files:**
- Modify: `.github/workflows/ci.yml`, `client/src/components/ServersOverview.tsx`, `client/src/components/Navbar.tsx`, `client/src/App.tsx`
- Create: `LICENSE`, `SECURITY.md`, `.github/dependabot.yml`

**Interfaces:**
- Produces: корректные пользовательские названия; падение `install`/`e2e` блокирует CI и релиз.

- [ ] Убрать `continue-on-error` у `install` и `e2e`, добавить MIT/SECURITY/Dependabot и исправить тексты «Включённые клиенты»/«Incy и mihomo».
- [ ] Проверить diff и YAML, выполнить клиентские типы/линт/сборку.

### Task 2: Журнал событий и Telegram

**Files:**
- Create: `server/src/services/event.service.ts`, `server/src/services/telegram.service.ts`, `server/src/routes/events.ts`, `server/src/routes/telegram.ts`, `server/test/events-telegram.test.ts`, `client/src/components/EventsView.tsx`, `client/src/components/TelegramCard.tsx`
- Modify: `server/src/db/index.ts`, `server/src/index.ts`, ключевые роуты и фоновые переходы, `client/src/api/index.ts`, `client/src/types/index.ts`, `client/src/App.tsx`, `client/src/components/Navbar.tsx`, `client/src/components/SecurityView.tsx`

**Interfaces:**
- `EventService.log(level: 'info'|'warning'|'error', type: string, message: string, entity?: {kind: string; id: number|string}): void`.
- `TelegramService.test(settings): Promise<{success: boolean; message: string}>`; доставка асинхронная и безопасная при ошибках.
- API: `GET /api/events?level=&limit=&offset=`, `GET/PUT /api/telegram`, `POST /api/telegram/test`.

- [ ] Написать падающие тесты на фильтрацию/retention событий, отсутствие секретов в API, Telegram payload, сбой сети и паузу при переносе; прогнать и убедиться в FAIL.
- [ ] Добавить миграцию `events`, EventService/TelegramService и API с валидацией; прогнать тесты до PASS.
- [ ] Инструментировать вход, ноды, пользователей, TLS, обновления и переходы offline/online без дублирования событий каждые 30 секунд.
- [ ] Добавить вкладку событий и карточку Telegram; проверить API и клиентские типы/сборку.

### Task 3: Облачные резервные копии и восстановление

**Files:**
- Create: `server/src/services/panel-archive.service.ts`, `server/src/services/backup-storage.ts`, `server/src/services/backup.service.ts`, `server/src/routes/backups.ts`, `server/src/cli/restore-backup.ts`, `server/test/backups.test.ts`, `server/test/backup-restore.test.ts`, `client/src/components/BackupsCard.tsx`, `docs/backups.md`
- Modify: `server/src/services/migration.service.ts`, `server/src/index.ts`, `server/package.json`, `client/src/api/index.ts`, `client/src/types/index.ts`, `client/src/components/SecurityView.tsx`, `server/src/utils/migration-archive.ts` при необходимости

**Interfaces:**
- `BackupStorage`: `test()`, `upload(name, data)`, `list()`, `download(id)`, `delete(id)` для Yandex WebDAV и Google OAuth.
- `BackupService.runNow(): Promise<{success: boolean; error?: string}>`; `runIfDue()` для фонового цикла.
- API: `GET/PUT /api/backups/settings`, `POST /api/backups/test`, `POST /api/backups/run`, `GET /api/backups`, `GET /api/backups/:id/download`, `DELETE /api/backups/:id`, `POST /api/backups/recovery-key`.
- CLI: `node server/dist/cli/restore-backup.js <архив> <ключ>`; перед заменой сохраняет прежний `data/`.

- [ ] Написать падающие тесты: round-trip архива, отсутствие сессий, неверный ключ, WebDAV/OAuth запросы, refresh Google token, ограничение списка, retention, одновременный запуск и migration pause; проверить FAIL.
- [ ] Выделить общий снимок панели, реализовать шифрование отдельным ключом и оба хранилища с таймаутами/валидацией; прогнать тесты до PASS.
- [ ] Реализовать расписание 24 ч/retention 10, API и CLI-восстановление с откатом; проверить полный restore round-trip.
- [ ] Добавить BackupsCard: подключение, проверка, запуск, список/скачивание/удаление и показ ключа после пароля; обновить документацию.

### Task 4: TOTP 2FA и управление сессиями

**Files:**
- Create: `server/src/utils/totp.ts`, `server/test/totp.test.ts`, `server/test/two-factor-sessions.test.ts`, `client/src/components/TwoFactorCard.tsx`, `client/src/components/SessionsCard.tsx`
- Modify: `server/src/db/index.ts`, `server/src/services/auth.service.ts`, `server/src/routes/auth.ts`, `server/src/middleware/auth.middleware.ts`, `client/src/components/LoginView.tsx`, `client/src/components/AccountModal.tsx`, `client/src/api/index.ts`, `client/src/types/index.ts`

**Interfaces:**
- `generateTotpSecret()`, `totpCode(secret, timestamp?)`, `verifyTotp(secret, code, timestamp?)`.
- Login принимает `totp?`/`recovery_code?` и возвращает либо `{token,user}`, либо `{totp_required:true}`.
- API настройки/подтверждения/отключения 2FA и `GET/DELETE /api/auth/sessions[/:id]`.

- [ ] Написать падающие тесты на известные TOTP-векторы, окно времени, включение, вход без/с кодом, одноразовость recovery code и отзыв сессий; проверить FAIL.
- [ ] Добавить миграцию полей 2FA/сессий и серверную реализацию с шифрованием/SHA-256/reauthLimiter; прогнать тесты до PASS.
- [ ] Добавить шаг кода в LoginView и карточки 2FA/сессий в учётную запись; проверить клиент.

### Task 5: Производительность опросов

**Files:**
- Modify: `server/src/routes/subscribers.ts`, `client/src/App.tsx`
- Test: `server/test/api-subscribers.test.ts`, `server/test/subscription-logic.test.ts`

**Interfaces:**
- Ответ `GET /api/subscribers` сохраняет текущую форму; реализация использует один агрегат трафика и один запрос пиров для всего списка.

- [ ] Добавить тест неизменного ответа и числа SQL-запросов при нескольких пользователях; проверить FAIL на старой реализации.
- [ ] Реализовать агрегированную сериализацию и получить PASS.
- [ ] Добавить in-flight guard, пропуск `document.hidden` и более редкую загрузку настроек без затирания форм; проверить клиент.

### Task 6: Клиентские тесты и разделение сборки

**Files:**
- Create: `client/vitest.config.ts`, `client/src/test/setup.ts`, критические `*.test.tsx`
- Modify: `client/package.json`, `client/package-lock.json`, `client/src/App.tsx`, `.github/workflows/ci.yml`

**Interfaces:**
- `npm test --prefix client` запускает Vitest; крупные вкладки загружаются через `React.lazy` с общим fallback.

- [ ] Подключить Vitest/jsdom/Testing Library и проверить запуск пустого набора.
- [ ] Добавить компонентные тесты на фильтр пользователей, метрики, 2FA-шаг входа и формы событий/резервных копий; проверить FAIL на вариантах с исходным поведением, затем добиться PASS и добавить тест в CI.
- [ ] Разделить крупные вкладки через lazy import, проверить сборку и отсутствие внешних ресурсов.

### Task 7: Документация, релиз и полная проверка

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/database.md`, `docs/security.md`, `docs/api.md`, `docs/testing.md`, `CHANGELOG.md`, корневой `package.json`

**Interfaces:**
- Produces: версия `0.2.5`, документированные настройки/CLI/инварианты и changelog v0.2.5.

- [ ] Обновить документы и инварианты для облачных секретов, backup pause, событий без секретов и 2FA.
- [ ] Выполнить `cd server && npx tsc --noEmit && npm test`.
- [ ] Выполнить `cd client && npx tsc -b && npm run lint && npm test && npx vite build`.
- [ ] Выполнить shellcheck для затронутых скриптов, проверить `git diff --check` и `git status`; удалить только созданные проверками артефакты.
- [ ] Закоммитить и отправить в `main` без force-push.
