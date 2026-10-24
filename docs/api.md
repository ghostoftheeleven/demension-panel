# HTTP API панели

Все `/api/*`, кроме отмеченных, требуют `Authorization: Bearer <токен сессии>`. Ошибки — JSON `{error}` с
HTTP-кодом. Тела — JSON.

## Публичные
| Метод | Путь | Описание |
|---|---|---|
| GET | `/sub/:token` | Подписка, см. [subscriptions.md](subscriptions.md) |
| GET | `/api/health` | `{status, uptime, https, timestamp}` |
| POST | `/api/auth/login` | `{username, password}` → `{token, user}`; 429 при переборе |
| GET | `/.well-known/acme-challenge/:token` | Let's Encrypt HTTP-01 |
| * | `/api/federation/v1/*` | Партнёрский API (токен партнёра), см. [partners.md](partners.md) |
| WS | `/ws` | Логи установки: `{type:'auth', token}` → `auth_ok` → `{type:'start_install', serverId}` → `log`… `install_finished` |

## Авторизация
`GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/change-password` (`{oldPassword, newPassword}` → новый `token`).

## Серверы `/api/servers`
| Метод | Путь | Описание |
|---|---|---|
| GET | `/`, `/:id` | Серверы (без секретов; `has_ssh_password`, `has_ssh_key`, параметры AWG, `remote_panel_name`…) |
| POST | `/` | Создать: `name, host, ssh_port, ssh_user, ssh_password \| ssh_key, awg_port, subnet`. 409, если сервер с таким хостом и портом AmneziaWG уже есть (то же при смене хоста/порта в PUT) |
| POST | `/import-amnezia` | `{keys}` — импорт по ключам AmneziaVPN, см. [amnezia-import.md](amnezia-import.md) |
| PUT | `/:id` | Изменить: имя/хост/SSH (`auth_type` + секрет), `reset_host_key`, порт, подсеть, параметры AWG. У установленного сервера смена порта/подсети/параметров ждёт применения на ноде; при неудаче — 502 `{success: false, error, server}`, порт и параметры возвращены к прежним (остальные правки сохранены) |
| DELETE | `/:id?teardown=1&force=1` | Удалить (опционально с контейнером на ноде) |
| POST | `/:id/test-ssh` | Проверка SSH |
| POST | `/:id/scan` | Найти и подключить установленный AmneziaWG |
| POST | `/:id/sync` | Синхронизировать пиры |
| POST | `/:id/apply` | Применить параметры (перезапуск) |
| POST | `/:id/randomize-params` | Новые параметры текущей версии + применение (при неудаче — 502, как у PUT, параметры прежние) |
| POST | `/:id/upgrade-protocol` | Переход на AWG 3.x + переустановка |

Для нод партнёра всё, кроме GET и sync, возвращает 400.

## Клиенты
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/servers/:serverId/clients` | Клиенты ноды (`external`, `partner_name`, `owner_blocked`, `pending`, `remote_state`) |
| POST | `/api/servers/:serverId/clients` | `{name?}` — создать (на ноде партнёра ждёт выдачи IP) |
| PUT | `/api/clients/:id` | `{name?, enabled?}`; для клиента партнёра `enabled` = блокировка владельцем |
| DELETE | `/api/clients/:id` | Удалить (клиента партнёра — 409) |
| GET | `/api/clients/:id/config` | `.conf` (409 для импортированных, партнёрских, ещё не созданных) |
| GET | `/api/clients/:id/qrcode` | `{qrcode, config, clientName}` |

## Пользователи подписок `/api/subscribers`
`GET /`, `POST /` (`name, server_ids, traffic_limit, expire_at`), `PUT /:id` (+ `enabled`), `DELETE /:id`,
`POST /:id/reset-token` (новый токен и ключи), `POST /:id/reset-traffic`.

## Настройки
- `GET/PUT /api/settings` — `public_url`, `client_dns`, `client_mtu`.
- `GET/PUT /api/subscription-settings` — оформление подписки и `servers[{id, sub_name, sub_order}]`.

## Партнёры
- Владелец `/api/partners`: `GET /`, `POST /` (`name, node_ids, max_clients, traffic_limit, expire_at` →
  `{partner, token, connect_string}`), `PUT /:id` (+ `enabled`), `POST /:id/regenerate-token`, `DELETE /:id`,
  `GET /:id/clients`, `GET /:id/audit`.
- Получатель `/api/remote-panels`: `GET /`, `POST /` (`connect_string, name?`), `POST /:id/sync`, `PATCH /:id`
  (`name`), `DELETE /:id`.

## Безопасность `/api/security`
`GET /ssl`, `POST /ssl/verify-cf`, `/ssl/cf-zones`, `/ssl/issue-cf`, `/ssl/issue-http`, `/ssl/issue-ip`,
`/ssl/custom`, `/ssl/toggle`; `GET /fail2ban`, `POST /fail2ban/ban`, `/fail2ban/unban`, `/fail2ban/setup`.
