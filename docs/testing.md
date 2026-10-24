# Тесты

Тесты сервера — vitest, каталог `server/test` (клиент проверяется типами, линтером и сборкой). Каждый тестовый файл
получает собственный каталог данных (`test/setup.ts` → `DEMENSION_DATA_DIR`) и, следовательно, свою БД; файлы
выполняются последовательно (`fileParallelism: false`).

```bash
cd server
npm test                                   # всё (≈ 1–2 мин; Docker-тесты пропускаются, если нод нет)
npx vitest run test/provision-service.test.ts      # один файл
npx vitest run -t "лимит клиентов"                 # по названию
npm i --no-save @vitest/coverage-v8@3.2.7          # один раз (без правки package.json)
npx vitest run --coverage --coverage.provider=v8 --coverage.include='src/**'
```

`npx tsc --noEmit` проверяет только `src` — типы тестов не проверяются (`Response.json()` возвращает `unknown`).

## Что где проверяется

| Файл | Что покрывает |
|---|---|
| `awg*.test.ts`, `net.test.ts`, `amnezia-key.test.ts`, `names.test.ts` | Чистые функции: параметры AWG и их проверка, подсети и IP, ключи AmneziaVPN, имена пиров, адрес редиректа |
| `auth.test.ts`, `admin-auth-settings.test.ts`, `login-lockout.test.ts` | Вход, сессии, смена пароля, блокировки, настройки панели и подписки |
| `admin-servers.test.ts` | Админ-API серверов и клиентов: валидация, отсутствие секретов, удаление, конфиги/QR, импорт ключей Amnezia |
| `provision-service.test.ts` | `ProvisionService` с подменой SSH: синхронизация, применение, установка, опрос, TOFU, разбор вывода сканирования, подключение установленного AWG |
| `federation-owner.test.ts`, `api-federation.test.ts`, `federation.test.ts` | Сторона владельца нод: изоляция партнёров, лимиты, приостановка, журнал, ограничения частоты |
| `admin-remote-security.test.ts` | Подключение панелей партнёров (сторона получателя), раздел «Безопасность» |
| `issues-regression.test.ts`, `hardening.test.ts` | Регрессии по Issues/Advisories и результатам аудитов (инъекции из данных партнёра, ошибки HTTP, CSP) |
| `subscription*.test.ts` | Публичная ссылка подписки, заголовки (только ASCII), приостановка по сроку и трафику |
| `ssl-service.test.ts`, `fail2ban-service.test.ts` | Сертификаты (самоподписанные, загруженные, продление, Cloudflare) и fail2ban (подставная утилита, только POSIX) |
| `migrations.test.ts` | Обновление БД со старых версий схемы (`initDatabase(targetVersion)`) |
| `server-process.test.ts` | Настоящий процесс панели: HTTP и HTTPS на одном порту, WebSocket, редирект, устойчивость к мусору |
| `reset-admin-cli.test.ts` | CLI сброса пароля администратора |
| `real-docker-nodes.test.ts`, `real-docker-lifecycle.test.ts` | Реальные ноды в Docker: установка, переустановка, 1.x → 3.x, применение, смена порта, TOFU, удаление |
| `real-docker-amnezia.test.ts` | Сервер с контейнером «как у приложения AmneziaVPN»: отказ установки поверх, подключение без перезапуска, синхронизация, применение, замена |
| `real-federation-e2e.test.ts` | Две панели-процесса и реальная нода: получатель → владелец → Docker |
| `test/install/run.sh` (не vitest) | `install.sh` целиком в чистом Ubuntu 24.04: случайные логин/пароль и вывод данных подключения, обновление, занятый порт, CLI сброса пароля (≈ 5 минут, нужны Docker и интернет) |

## Хелперы (`test/helpers`)

| Хелпер | Для чего |
|---|---|
| `api.ts` → `createAdminApi(env, username)` | Клиент админ-API тестового приложения (`test-app.ts`): `api(path, method, body)` → `{status, body}` |
| `db.ts` → `insertServer/insertClient/insertSubscriber` | Прямые вставки в БД с валидными ключами и параметрами |
| `ssh-stub.ts` → `stubSsh(responder)` | Подмена `SshService.executeCommand`: записывает команды и stdin (`calls`), ответ задаёт `responder` |
| `remote-panel.ts` → `newRemote`, `createRemotePanel` | Имитация панели владельца нод (подмена `fetch`); поля `failWith`, `latencyMs`, `assignedIp`, `nodeParams` управляют ответами |
| `panel-process.ts` → `startPanel`, `eventually` | Реальный процесс панели с собственной БД и портом, запросы по HTTP/TLS, ожидание фоновых операций |

`test-app.ts` собирает те же роутеры и тот же `errorHandler`/`securityHeaders`, что `src/index.ts`; всё, что живёт только в
`index.ts` (WebSocket, HTTPS на одном порту, фоновые циклы), проверяется через `startPanel`.

## Правила для новых тестов

1. **Проверяйте реальный код** — роуты, сервисы, БД. Нельзя копировать логику в тест и «доказывать» её (так были устроены
   первые `edge-cases.test.ts`, они заменены).
2. Тест на баг должен **падать на старом коде**: перед коммитом откатите исправление (`git stash push -- server/src/...`)
   и убедитесь.
3. Не обращайтесь к реальной сети и SSH: `stubSsh` для SSH, `stubRemotePanel` для панели партнёра, `vi.stubGlobal('fetch')`
   для Cloudflare. Подмену `fetch` нужно сопровождать `passthroughBaseUrl`, если тест сам ходит в тестовое приложение.
4. Ограничители (`FailureLimiter`, лимит партнёра) глобальны для файла: тесты, исчерпывающие лимит, ставьте последними
   или сбрасывайте счётчики (`loginIpLimiter.reset(ip)`).
5. Проверки утечек секретов — по именам полей в кавычках (`"ssh_password"`), а не подстроке: поле `has_ssh_password` легально.
6. Тесты процесса и Docker требуют таймаутов (`it(..., 120000)`), а ожидание фоновой синхронизации — `eventually`/`vi.waitFor`,
   не `sleep`.
7. Новая функция или правка поведения — тест и строка в нужном документе (`docs/`), а при новом правиле — пункт в
   `AGENTS.md`.

## Реальные ноды в Docker

`real-docker-*.test.ts` и `real-federation-e2e.test.ts` ищут ноды по открытому SSH-порту (2222 — нода 1, 2223 — нода 2) и
пропускаются, если их нет. Нода — контейнер Docker-in-Docker с `sshd` (root / `rootpass123`, `--privileged`); Dockerfile и
скрипт — в `server/test/docker`:

```bash
server/test/docker/nodes.sh up       # собрать образ, запустить demension-node-1 (SSH 2222) и demension-node-2 (SSH 2223)
server/test/docker/nodes.sh status
server/test/docker/nodes.sh down
```

Тесты сами удаляют установленный на ноде контейнер `amnezia-awg`. Нода 1 используется `real-docker-nodes` и
`real-federation-e2e` (последовательно), нода 2 — `real-docker-lifecycle`. Образ AmneziaWG скачивается внутри ноды при первой
установке (нужен интернет).

## CI

`.github/workflows/ci.yml`: `server` (типы, тесты без Docker, сборка), `client`, `scripts` (shellcheck), `install` (`install.sh` в чистом
Ubuntu, `test/install/run.sh`) и `e2e` — поднимает
тестовые ноды и запускает весь набор, включая Docker-тесты (`continue-on-error`, пока не накоплена статистика стабильности).
Локально ту же проверку на Linux можно выполнить в контейнере:

```bash
docker run --rm -v "$PWD:/src:ro" node:24-alpine sh -c \
  'mkdir /work && cd /src && tar cf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=data . | tar xf - -C /work \
   && cd /work/server && npm ci && npx vitest run'
```
