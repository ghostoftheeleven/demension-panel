# AGENTS.md — руководство для ИИ-агентов и разработчиков

Demension Panel — агентлесс-панель управления нодами **AmneziaWG**: разворачивает AmneziaWG в Docker на удалённых
серверах по SSH, выдаёт клиентские конфиги и автообновляемые подписки, умеет подключать уже установленные серверы
(в т.ч. из приложения AmneziaVPN) и делиться нодами между панелями.

Перед любыми изменениями прочитайте этот файл целиком, а затем документ подсистемы, которую трогаете.

| Документ | О чём |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Компоненты, структура кода, потоки данных, фоновые задачи |
| [docs/database.md](docs/database.md) | Схема БД, миграции, смысл каждого поля |
| [docs/node-management.md](docs/node-management.md) | Установка, синхронизация, применение параметров, сканирование и импорт, мониторинг |
| [docs/awg-protocol.md](docs/awg-protocol.md) | Параметры обфускации AmneziaWG 1.x / 3.x, ограничения, генерация |
| [docs/subscriptions.md](docs/subscriptions.md) | Форматы подписок (Incy, mihomo, JSON), заголовки, оформление, лимиты |
| [docs/partners.md](docs/partners.md) | Партнёрский доступ к нодам между панелями: модель и API `/api/federation/v1` |
| [docs/amnezia-import.md](docs/amnezia-import.md) | Перенос серверов из AmneziaVPN по ключу «Полный доступ» (`vpn://`) |
| [docs/security.md](docs/security.md) | Авторизация, секреты, HTTPS на одном порту, ограничения частоты, fail2ban |
| [docs/api.md](docs/api.md) | Справочник HTTP API панели |

## Структура репозитория

```
server/            Node.js 22.13+ / Express 4 / TypeScript, SQLite через node:sqlite
  src/index.ts       точка входа: HTTP+HTTPS на одном порту, WebSocket, фоновые задачи
  src/db/index.ts    схема и миграции (PRAGMA user_version)
  src/routes/        HTTP API
  src/services/      бизнес-логика (SSH, провижининг, подписки, партнёры, HTTPS…)
  src/utils/         чистые функции (сети, параметры AWG, ключи Amnezia, HTTP-утилиты)
  src/scripts/deploy-awg.sh  скрипт развёртывания ноды (передаётся по SSH через stdin)
  src/cli/reset-admin.ts     сброс логина/пароля администратора
  test/              vitest
client/            React 19 + Vite + Tailwind 4 (SPA, собирается в client/dist и раздаётся сервером)
install.sh         установка панели на VPS (systemd)
docs/              документация
```

## Команды

```bash
npm install --prefix server && npm install --prefix client
npm run dev:server            # бэкенд :3001 (tsx watch)
npm run dev:client            # фронтенд :3000, прокси /api, /sub, /ws на :3001
cd server && npx tsc --noEmit && npm test     # проверка типов и тесты сервера
cd client && npx tsc -b && npm run lint && npx vite build
npx shellcheck -S error install.sh server/src/scripts/deploy-awg.sh
```

CI (`.github/workflows/ci.yml`) выполняет всё перечисленное на каждый push в `main`.

## Правила работы с репозиторием

- Готовая работа коммитится и пушится **сразу в `main`** (так решил владелец проекта). Без force-push.
- Shell-скрипты хранятся с LF (`.gitattributes`). На Windows с `core.autocrlf=true` рабочие файлы могут быть с CRLF —
  учитывайте это в скриптах, которые патчат исходники.
- Тексты интерфейса и сообщения об ошибках — на русском.
- Новые функции сопровождайте тестами в `server/test` и обновлением соответствующего документа в `docs/`.

## Критические инварианты — не ломать

Каждый пункт — реальная ошибка, которая уже была или легко возникает. Если изменение затрагивает пункт, перечитайте
соответствующий документ.

### Безопасность
1. **API никогда не отдаёт секреты.** `serializeServer` (routes/servers.ts) вырезает `ssh_password`, `ssh_key`,
   `server_private_key`, `preshared_key`; `serializeClient` — `client_private_key`. Приватный ключ клиента попадает
   только в `.conf`/QR/подписку.
2. **SSH-пароли/ключи и токен Cloudflare хранятся зашифрованными** (`encryptSecret`/`decryptSecret`, ключ
   `data/secret.key` или `DEMENSION_SECRET_KEY`). Никогда не пишите их в БД напрямую и не логируйте.
3. **Токены сессий и партнёров хранятся только как SHA-256.** Сам токен показывается один раз.
4. **Токен авторизации — только в заголовке `Authorization: Bearer`.** Не принимайте его из query-string; скачивание
   конфигов идёт через `fetch` + Blob. WebSocket авторизуется первым сообщением `{type:'auth', token}`.
5. **Никакой подстановки пользовательских данных в shell.** Значения для удалённых команд проходят валидацию и
   `shellQuote`; локальные команды — через `execFile` с массивом аргументов (см. fail2ban.service.ts).
6. **Async-обработчики Express 4 оборачивайте в `asyncHandler`.** Иначе отклонённый промис завершит процесс. Ошибки
   для пользователя бросайте как `HttpError(status, message)`.
7. **Каждый WebSocket должен иметь `ws.on('error')`** — иначе один битый фрейм роняет панель.
8. Партнёрский API работает **только по HTTPS** (`req.secure`); исключение — `ALLOW_INSECURE_FEDERATION=1` для разработки.

### Ноды и VPN
9. **Все операции с одной нодой идут через очередь `runExclusive`** (provision.service.ts). Синхронизацию запрашивайте
   через `ProvisionService.requestSync(serverId)` — не вызывайте SSH-команды напрямую из роутов.
10. **Конфиг ноды генерируется целиком из БД** (`AwgService.generateServerConfig`). Всё, чего нет в БД, при
    синхронизации исчезнет с ноды. Поэтому пиры при импорте сохраняются как клиенты (`external = 1`).
11. **Операции с контейнером — через поля сервера** `container_name`, `iface`, `conf_path`, `awg_tool`, `managed_by`
    (контейнер может быть чужим — приложения Amnezia, с `wg0`/`wg`). Не хардкодьте `amnezia-awg`/`awg0`.
12. **`awg syncconf` не меняет параметры интерфейса.** Смена обфускации требует `requestApply` (перезапуск контейнера),
    смена порта — переустановки (`deployed_port !== awg_port`). Подсеть при наличии клиентов менять нельзя.
13. **Клиент активен на ноде** только если `enabled = 1`, `owner_blocked = 0`, его подписчик активен
    (`enabled` и не `suspended`), а для клиента партнёра — доступ включён, не приостановлен и нода не отозвана.
    Логика в одном месте — SQL в `ProvisionService.getServerClients`. Используйте его.
14. **Трафик накапливается дельтами** (`rx_counter`/`tx_counter`), потому что счётчики интерфейса сбрасываются.
    `total_rx` — отправлено клиентом (upload), `total_tx` — получено клиентом (download).
15. **На ноды всегда ставится `amneziavpn/amneziawg-go:latest`** (решение владельца). Образ только amd64.
16. Ноды партнёра (`servers.remote_panel_id IS NOT NULL`) не имеют SSH: любые SSH-операции для них запрещены
    (`loadLocalServer` / `getLocalServerOr404`), синхронизация уходит в `FederationClient`.

### Протокол и подписки
17. **Параметры AWG проверяются `validateAwgParams`** (utils/awg-params.ts) при любом изменении пользователем:
    `S1+56 ≠ S2`, `Jmin ≤ Jmax ≤ 1280`, H1–H4 не пересекаются, с `HeaderProtectionKey` все S1–S4 ≥ 12, `S4 ≤ 32`.
    Импортированные с ноды параметры сохраняются как есть, даже если не проходят проверку.
18. **Новые серверы получают параметры актуальной версии (3.x); существующие версии 1.x не меняются молча** — только
    по действию «Перейти на 3.x» (иначе у всех клиентов пропадёт VPN).
19. **HTTP-заголовки — только ASCII.** Тексты (название, описание, объявление) передаются как `base64:…`, имена
    файлов — через `contentDisposition()`. Кириллица в `setHeader` роняет запрос с `ERR_INVALID_CHAR`.
20. **Ссылки подписки, выданные по `http://`, должны продолжать работать после включения HTTPS.** Поэтому HTTP и HTTPS
    обслуживаются на одном порту, а `/sub` и ACME-challenge доступны по HTTP.

### База данных
21. **Схема меняется только новой миграцией** в конец массива `migrations` (db/index.ts). Существующие миграции не
    редактируйте — они уже применены у пользователей. Колонки добавляйте через `addColumn`.
22. Связанные изменения (создание клиента + выделение IP и т.п.) — в `transaction()`. Уникальность IP клиента на
    сервере обеспечивает индекс `idx_clients_server_ip`.

## Чек-лист перед коммитом

- [ ] `cd server && npx tsc --noEmit && npm test`
- [ ] `cd client && npx tsc -b && npm run lint && npx vite build`
- [ ] shellcheck, если менялись `install.sh` / `deploy-awg.sh`
- [ ] Новые поля сервера/клиента не утекают в API (п. 1) и, если нужны клиенту, добавлены в `client/src/types`
- [ ] Изменение схемы — новой миграцией (п. 21)
- [ ] Обновлён документ в `docs/` для изменённой подсистемы
