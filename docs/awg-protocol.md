# Параметры AmneziaWG

Код — `server/src/utils/awg-params.ts`. Источники спецификации: README
[amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go), парсер `src/config.c`
[amneziawg-tools](https://github.com/amnezia-vpn/amneziawg-tools), валидация `device/uapi.go`
(`mergeWithDevice`), шаблоны конфигов [amnezia-client](https://github.com/amnezia-vpn/amnezia-client)
(`client/server_scripts/awg*/`).

## Параметры

| Параметр | Сторона | Формат / ограничения |
|---|---|---|
| `Jc`, `Jmin`, `Jmax` | клиент | Мусорные пакеты перед рукопожатием. `Jc` 0–128 (рекомендуется 4–12), `Jmin ≤ Jmax ≤ 1280` |
| `S1`, `S2` | **сервер и клиент** | Паддинг init/response, uint16. `S1 ≤ 1132`, `S2 ≤ 1188`, **`S1 + 56 ≠ S2`** |
| `S3`, `S4` | **сервер и клиент** | Паддинг cookie/transport (2.0+). `S4 ≤ 32` |
| `H1`–`H4` | **сервер и клиент** | Заголовки типов сообщений, uint32: число (1.x) или диапазон `a-b` (2.0+). **Диапазоны не должны пересекаться**; 0–4 зарезервированы WireGuard |
| `I1`–`I5` | клиент | Сигнатурные пакеты из тегов `<b 0xHEX>`, `<r N>`, `<rd N>`, `<rc N>`, `<t>` (`<c>` не поддерживается amneziawg-go). Панель кладёт их только в клиентский конфиг |
| `HeaderProtectionKey` | **сервер и клиент** | 3.x. Ключ base64 (как `awg genkey`). Требует **S1–S4 ≥ 12** |
| `ContentPaddingAddition`, `RekeyAfterTime`, `RekeyTimeout`, `RejectAfterTime`, `KeepaliveTimeout`, `MaxHandshakeAttempts`, `RandomTrailers`, `DisableCookies` | см. README | 3.x. Панель их не генерирует, но сохраняет из импортированных конфигов (`extra_params`) и передаёт клиентам |

Все параметры пишутся в секцию `[Interface]`. Отсутствующий параметр AWG трактует как 0.

**`RandomTrailers = on` должен понимать и клиент.** Нода с ним дописывает случайный хвост к ответу на рукопожатие (и к cookie),
а amneziawg-go без этой опции принимает служебные пакеты только точного размера (`DeterminePacketTypeAndPadding`) — ответ
отбрасывается, рукопожатие не завершается. В mihomo опция `random-trailers` есть с v1.19.30 (AmneziaWG 3.1), в FlClash — с
v0.8.97; более старые ядра молча игнорируют ключ из подписки. Панель передаёт `random-trailers: true` в `amnezia-wg-option`.

## Версии в панели (`awg_version`)

- **1** — AmneziaWG 1.x: одиночные H, без S3/S4/HPK. Так хранятся серверы, созданные до поддержки 3.x.
- **3** — AmneziaWG 3.x (`LATEST_AWG_VERSION`): S3, S4, диапазоны H, HeaderProtectionKey.

Новые серверы получают версию 3. Серверы 1.x переводятся только явно («Перейти на 3.x»): новые параметры +
переустановка со свежим образом. Клиентам после этого нужно обновить подписку, а их приложения должны поддерживать
AmneziaWG 3.x.

## Генерация (`generateAwgParams`)

Версия 3: `Jc` 4–10, `Jmin` 40–80, `Jmax` = `Jmin` + 20…150, `S1`/`S2` 15–150 (без `S1+56=S2`), `S3` 12–55,
`S4` 12–32, четыре диапазона H шириной 10 000–5 000 000 — по одному в каждой четверти пространства uint32, в случайном
порядке, `HeaderProtectionKey` — 32 случайных байта.

## Проверка (`validateAwgParams`)

Применяется ко всем изменениям, сделанным пользователем (PUT сервера). Параметры, импортированные с работающей ноды,
сохраняются как есть — менять их молча нельзя, иначе отвалятся существующие клиенты.

## Где используются

- `AwgService.generateServerConfig` / `generateClientConfig` → `renderAwgLines(params, 'server' | 'client')`.
- Подписки: `.conf` внутри `awg://` и JSON Incy; `mihomoAmneziaOption` (routes/subscription.ts) для mihomo
  (`version: 3`, `s3`, `s4`, `h1..h4` строками, `i1..i5`, `header-protection-key`, доп. параметры в kebab-case).
- Партнёрский API отдаёт параметры нод (`PartnerService.nodePayload`), получатель сохраняет их как есть.
