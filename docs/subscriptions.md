# Подписки

Код — `server/src/routes/subscription.ts`, оформление — `services/subscription-settings.service.ts`,
лимиты — `services/subscription.service.ts`.

## Эндпоинт `GET /sub/:token`

Публичный, без авторизации; доступен по HTTP даже при включённом HTTPS (выданные ссылки не должны ломаться).
- Неизвестный токен — 404, выключенный подписчик — 403.
- Истёк срок или исчерпан лимит — 200 с пустым списком и заголовками (приложение покажет срок/трафик).
- В подписку попадают клиенты подписчика с `enabled = 1`, `external = 0`, не `pending:` и не `blocked` владельцем,
  на нодах со статусом не `uninstalled` (временно недоступная нода не пропадает из приложения).
- Порядок — `servers.sub_order`, имя — `servers.sub_name` или имя сервера; при включённой проверке доступности из стран к имени добавляются
  пометки ` · 🇷🇺✅ 🇰🇿❌` ([probes.md](probes.md)).

## Форматы

| Формат | Как выбирается | Тело |
|---|---|---|
| Incy (по умолчанию) | `?format=awg`/`incy` или любой UA | base64 списка строк `awg://<base64url(.conf)>#<имя>` ([спецификация](https://docs.incy.cc/en/subscription-format/)) |
| JSON Incy | `?format=json` | `{"type":"amneziawg","version":1,"servers":[{"name","config":"<base64url .conf>"}]}` |
| mihomo | `?format=clash`/`mihomo` или UA `mihomo`, `clash-meta`, `clash-verge`, `flclash`, `clashmi`, `clash.party` | JSON (валидный YAML): `proxies` (`type: wireguard` + `amnezia-wg-option`), группа `Demension`, `rules: MATCH,Demension` |

В `[Peer]` строка `PresharedKey` (в mihomo — `pre-shared-key`) пишется только если у клиента или сервера есть PSK.
`AllowedIPs = 0.0.0.0/0, ::/0` — намеренно: у нод нет IPv6, и маршрут `::/0` в туннель не даёт IPv6-трафику клиента идти
мимо VPN (утечка реального адреса); так же настроены конфиги приложения AmneziaVPN. Не убирайте `::/0`.

Клиенты с поддержкой AmneziaWG из подписки: **Incy** (iOS, Android), клиенты на ядре **mihomo** (Clash Verge Rev,
FlClash, Mihomo Party, Clash Meta for Android). HAPP, v2rayNG, Karing AmneziaWG не поддерживают; приложения
AmneziaWG/AmneziaVPN не умеют подписки по ссылке.

## Заголовки

| Заголовок | Источник |
|---|---|
| `Subscription-Userinfo` | `upload=total_rx; download=total_tx; total=traffic_limit; expire=unix` |
| `Profile-Title` | `base64:` + шаблон названия (`{user}` → имя), обрезка до 25 символов |
| `Profile-Update-Interval` | Часы (1–168, по умолчанию 12) |
| `Profile-Description`, `Announce` | `base64:` (объявление до 200 символов). Если включена проверка доступности из стран ([probes.md](probes.md)), к описанию добавляется строка с пояснением |
| `Announce-Url`, `Support-Url`, `Profile-Web-Page-Url` | URL, нормализованные в ASCII (`URL.href`) |
| `Support-Email`, `Sort-Order` (`ping`/`name`/`none`), `Hide-Url: 1` | Как есть |
| `Content-Disposition` | `contentDisposition('inline', '<имя>.txt|yaml')` |

**Только ASCII в заголовках** — иначе Node.js бросает `ERR_INVALID_CHAR`.

## Оформление

Страница «Оформление подписки» (`SubscriptionSettingsView.tsx`), API `GET/PUT /api/subscription-settings`
(`{ settings, servers: [{id, sub_name, sub_order}] }`). Значения хранятся в `settings` с префиксом `sub_`.

## Лимиты подписчиков

`traffic_limit` (байты) и `expire_at`. `SubscriptionService.refreshSuspension` (фоновая задача) выставляет
`suspended`, после чего клиенты подписчика снимаются с нод синхронизацией. Трафик подписчика — сумма по его клиентам.

## Сброс ссылки

`POST /api/subscribers/:id/reset-token` меняет токен **и перевыпускает ключи всех клиентов** подписчика (для нод
партнёра клиент создаётся заново). Иначе тот, кто скачал старую подписку, сохранил бы доступ.

## Публичный адрес

Ссылки строятся от `settings.public_url` или `window.location.origin` (настройка в «Безопасность → Настройки панели»).
