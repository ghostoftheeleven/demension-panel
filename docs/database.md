# База данных

SQLite (`node:sqlite`, Node ≥ 22.13), файл `data/demension.db`, режим WAL, `foreign_keys = ON`, `busy_timeout = 5000`.

## Миграции

`server/src/db/index.ts`, массив `migrations`; номер применённой версии — `PRAGMA user_version`. Каждая миграция
выполняется в транзакции при старте (`initDatabase`).

**Правила:**
- Новые изменения — только новой функцией в конце массива. Применённые миграции не редактировать.
- Колонки — через `addColumn(table, definition)` (идемпотентно).
- Данные, которые меняют смысл (шифрование, хэширование), переносите в миграции, а не «на лету».

| Версия | Что добавила |
|---|---|
| v1 | Исходная схема: admins, sessions, subscribers, servers, clients, settings |
| v2 | Флаги синхронизации, TOFU host_key, накопление трафика, приостановка подписчиков, уникальные IP, шифрование секретов, хэши сессий |
| v3 | `servers.sub_name`, `sub_order` (имена/порядок в подписке) |
| v4 | Параметры AWG 3.x, поля контейнера (`container_name`, `iface`, `conf_path`, `awg_tool`, `managed_by`), `clients.external` |
| v5 | Партнёрский доступ: `partners`, `partner_nodes`, `partner_audit`, `remote_panels`; поля клиентов/серверов для партнёров |

## Таблицы

### `servers` — ноды
| Поле | Смысл |
|---|---|
| `host`, `ssh_port`, `ssh_user` | SSH-доступ (`ssh_user='partner'` у нод партнёра) |
| `ssh_password`, `ssh_key` | **Зашифрованы** (`enc:v1:…`). Одно из двух |
| `host_key` | Отпечаток SSH-ключа хоста (TOFU), сбрасывается при смене host |
| `awg_port`, `deployed_port` | Желаемый порт и порт, с которым создан контейнер; различие → переустановка |
| `subnet` | Адрес сервера в туннеле с маской (`10.8.0.1/24`; у Amnezia бывает адрес сети `10.8.1.0/24`) |
| `server_private_key`, `server_public_key`, `preshared_key` | Ключи интерфейса (приватный не уходит в API) |
| `awg_version` | 1 — AmneziaWG 1.x, 3 — 3.x |
| `jc, jmin, jmax, s1, s2, s3, s4, h1..h4, i1..i5, header_protection_key, extra_params` | Параметры обфускации, см. [awg-protocol.md](awg-protocol.md). `h1..h4` — текст (число или диапазон) |
| `status` | `uninstalled`, `installing`, `online`, `offline`, `error` |
| `needs_sync`, `needs_apply` | Изменения ещё не доставлены на ноду (повторяются фоновым опросом) |
| `last_error`, `fail_count`, `last_seen` | Состояние опроса; 3 неудачи подряд → `offline` |
| `container_name`, `iface`, `conf_path`, `awg_tool` | Где AmneziaWG на ноде (`amnezia-awg`/`awg0`/`/opt/amnezia/awg/awg0.conf`/`awg` у панели) |
| `managed_by` | `demension` — контейнер панели, `amnezia` — контейнер приложения Amnezia, `partner` — нода партнёра |
| `sub_name`, `sub_order` | Отображаемое имя и порядок в подписке |
| `remote_panel_id`, `remote_node_id` | Нода партнёрской панели (без SSH); каскадное удаление с `remote_panels` |

### `clients` — пиры
| Поле | Смысл |
|---|---|
| `server_id`, `subscriber_id` | Нода; пользователь-подписчик (NULL — отдельный клиент) |
| `client_ip` | Уникален в пределах сервера (`idx_clients_server_ip`). `pending:<uuid>` — клиент на ноде партнёра ещё не создан у владельца |
| `client_public_key`, `client_private_key` | Приватный пуст (`''`) у импортированных и у клиентов партнёра на нашей ноде |
| `preshared_key` | PSK пира |
| `enabled` | Включён самим владельцем клиента |
| `total_rx`, `total_tx`, `rx_counter`, `tx_counter` | Накопленный трафик и последние значения счётчиков интерфейса |
| `external` | Импортирован из существующей установки (конфиг выдать нельзя) |
| `partner_id`, `remote_ref` | Сторона владельца: клиент создан партнёром; `remote_ref` — id клиента у партнёра (идемпотентность) |
| `owner_blocked` | Сторона владельца: заблокирован владельцем ноды (партнёр включить не может) |
| `remote_peer_id`, `remote_state` | Сторона получателя: id пира у владельца; `blocked` или `error: …` |

### `subscribers` — пользователи подписок
`token` (секрет ссылки `/sub/<token>`), `enabled`, `traffic_limit` (байты, 0 — без лимита), `expire_at`,
`suspended` (вычисляется фоновой задачей: истёк срок или исчерпан лимит).

### `partners`, `partner_nodes`, `partner_audit` — выданные доступы (сторона владельца)
`token_hash` (SHA-256), `token_hint` (для отображения), `enabled`, `suspended`, `max_clients`, `traffic_limit`,
`expire_at`, `last_used_at`, `last_ip`. `partner_nodes` — какие ноды доступны. Журнал хранит до 1000 записей на партнёра.

### `remote_panels` — подключённые панели партнёров (сторона получателя)
`base_url`, `token` (**зашифрован**), `partner_name` (как нас назвал владелец), `status`
(`pending`/`online`/`error`/`revoked`), `limits` (JSON), `last_sync_at`, `last_error`.

### Прочее
- `admins` — администратор (scrypt), `sessions` — SHA-256 токенов с `expires_at`.
- `settings` — ключ/значение: `ssl_*`, `cf_token` (**зашифрован**), `public_url`, `client_dns`, `client_mtu`,
  `sub_*` (оформление подписки).
