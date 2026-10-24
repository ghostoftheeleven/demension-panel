# Архитектура

## Компоненты

```
 Браузер админа ──HTTPS/HTTP──► Панель (server/src/index.ts)
                                 │  Express API /api/*, SPA client/dist, подписки /sub/:token, WebSocket /ws
                                 │  SQLite data/demension.db
                                 │
                                 ├──SSH──► Нода 1: Docker-контейнер AmneziaWG (панели или приложения Amnezia)
                                 ├──SSH──► Нода N
                                 └──HTTPS──► Панель партнёра (/api/federation/v1)  ← и обратно
 Приложения пользователей (Incy, mihomo) ──► /sub/:token
 VPN-трафик пользователей ──UDP──► ноды напрямую (панель в передаче трафика не участвует)
```

Панель **агентлесс**: на нодах нет демона панели, только Docker-контейнер AmneziaWG. Все действия — SSH-командами.

## Сервер (`server/src`)

| Файл | Назначение |
|---|---|
| `index.ts` | Порядок middleware, роутеры, единый порт HTTP+HTTPS (сниффинг первого байта), WebSocket установки, фоновые задачи |
| `config.ts` | Каталог данных (`DEMENSION_DATA_DIR`, по умолчанию `./data`) |
| `db/index.ts` | Схема, миграции, `transaction`, `getSetting`/`setSetting` |
| `middleware/auth.middleware.ts` | `requireAuth` (Bearer-токен сессии) |
| `middleware/rate-limit.ts` | `FailureLimiter` — счётчик неудачных попыток (логин, токены партнёров) |
| `routes/*.ts` | HTTP API, см. [api.md](api.md) |
| `services/ssh.service.ts` | SSH: TOFU-проверка ключа хоста, таймауты, stdin, `sudo -n` для не-root |
| `services/provision.service.ts` | Всё про ноды: установка, синхронизация, применение, сканирование и импорт, мониторинг |
| `services/awg.service.ts` | Ключи, генерация серверных/клиентских конфигов, выделение IP |
| `services/subscription*.ts` | Лимиты подписчиков и оформление подписки |
| `services/partner.service.ts` | Партнёрский доступ — сторона владельца нод |
| `services/federation-client.service.ts` | Партнёрский доступ — сторона получателя |
| `services/ssl.service.ts` | Let's Encrypt (DNS-01 Cloudflare, HTTP-01), самоподписанные и свои сертификаты, автопродление |
| `services/secrets.service.ts` | Шифрование секретов в БД (AES-256-GCM) |
| `services/auth.service.ts` | Пароли (scrypt), сессии (SHA-256 токенов) |
| `services/fail2ban.service.ts` | fail2ban на хосте панели |
| `utils/awg-params.ts` | Параметры AWG: генерация, проверка, рендер, разбор конфигов |
| `utils/amnezia-key.ts` | Разбор ключей AmneziaVPN `vpn://` |
| `utils/net.ts` | Подсети, выделение IP, `shellQuote`, проверки хостов/портов |
| `utils/http.ts` | `HttpError`, `asyncHandler`, `contentDisposition`, `base64HeaderValue`, `parseId` |

## Клиент (`client/src`)

SPA без роутера: вкладки в `App.tsx` (`AppTab` из `Navbar.tsx`): Серверы, Пользователи, Оформление подписки,
Партнёры, Безопасность. Все запросы — через `api/index.ts` (`request()` с Bearer-токеном из localStorage;
на 401 генерируется событие `auth_unauthorized`). Типы ответов сервера — `types/index.ts`; держите их в
соответствии с сериализаторами сервера. Данные опрашиваются каждые 15 с (`App.tsx`), формы инициализируются
только при открытии модалок (иначе опрос затирает ввод).

## Фоновые задачи (`index.ts`)

| Задача | Период | Что делает |
|---|---|---|
| `statsLoop` | 30 с после завершения | Опрос нод (`fetchServerStats`, до 5 параллельно): трафик, статус, досинхронизация; пересчёт приостановки подписчиков и партнёров |
| `federationLoop` | 60 с | Синхронизация с панелями партнёров (`FederationClient.syncAll`) |
| очистка | 1 ч | Истёкшие сессии, счётчики ограничений |
| `renewIfNeeded` | 12 ч | Продление сертификата Let's Encrypt за 30 дней до окончания |

## Порядок middleware (важно)

1. Заголовки безопасности.
2. `/.well-known/acme-challenge/:token`, затем `/sub` — доступны по HTTP даже при включённом HTTPS.
3. Перенаправление на HTTPS (для `/api/*` по HTTP — 403 JSON), когда HTTPS включён.
4. `express.json` (1 МБ), `/api/health`, `/api/federation/v1`, `/api/auth`, защищённые роутеры, JSON-404 для `/api/*`.
5. Статика SPA и fallback на `index.html`.
6. JSON error handler (`HttpError`, ошибки парсинга JSON, 500 без стектрейса).
