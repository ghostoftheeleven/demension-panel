# Перенос серверов из AmneziaVPN

Пользователь AmneziaVPN может перенести свои серверы в панель **без переустановки**: в приложении сервер →
«Поделиться» → «Полный доступ» → ключ `vpn://…`, затем в панели «Добавить сервер» → «Из AmneziaVPN (ключ)».
Можно вставить несколько ключей (по одному на строку, до 50).

Код: разбор ключа — `server/src/utils/amnezia-key.ts`; эндпоинт — `POST /api/servers/import-amnezia`
(routes/servers.ts); UI — `AmneziaImportPanel.tsx` внутри `AddServerModal.tsx`.

## Формат ключа

Из исходников amnezia-client (`core/controllers/selfhosted/exportController.cpp`, `importController.cpp`):

```
vpn:// + base64url_без_паддинга( qCompress(JSON, 8) )
qCompress = 4 байта длины исходных данных (big-endian) + поток zlib
```

Поля JSON ключа полного доступа: `hostName`, `port` (SSH), `userName`, `password` (это `secretData`: **пароль или
приватный SSH-ключ** в PEM), `description`, `containers[{container}]`, `defaultContainer`, `dns1`, `dns2`.
Ключ обычного подключения не содержит SSH-данных и отклоняется с подсказкой. Для совместимости `decodeAmneziaKey`
также принимает zlib без заголовка и несжатый JSON. `encodeAmneziaKey` — обратная операция для тестов.

## Что происходит при импорте

Для каждого ключа:
1. Разбор ключа (`invalid` при ошибке).
2. Пропуск, если сервер с таким адресом уже есть (`exists`).
3. Создание сервера (`insertServer`) с SSH-доступом из ключа; пароль/ключ шифруются, сам `vpn://`-ключ **не
   сохраняется**.
4. `ProvisionService.scanAndAdopt` — см. [node-management.md](node-management.md#сканирование-и-подключение-без-переустановки-scanandadopt):
   найденный контейнер AmneziaWG (обычно `amnezia-awg2` или legacy `amnezia-awg` с `wg0.conf`) подключается с
   ключами, параметрами и клиентами (имена — из `clientsTable` Amnezia). Статус `adopted`.
5. Если AmneziaWG не найден (на сервере только другие протоколы Amnezia) — `needs_install`, сервер можно установить
   из панели. Ошибка SSH — `ssh_error`, сервер остаётся в панели для исправления доступа.

Ответ: `{ results: [{ key, name, serverId, status, message, importedPeers }] }`.

## Что важно помнить

- Клиенты, созданные в AmneziaVPN, импортируются как `external` — они работают, но их конфиги выдать нельзя
  (приватных ключей у панели нет). Новых клиентов создают в панели — они записываются в конфиг того же контейнера
  через `docker exec`.
- **После импорта не меняйте клиентов этих серверов в приложении AmneziaVPN**: при синхронизации панель перезапишет
  конфиг контейнера из своей БД, и изменения из приложения пропадут. Новые клиенты панели не попадают в
  `clientsTable` Amnezia.
- Смена порта или «Переустановить AWG» заменяет контейнер Amnezia контейнером панели (`REPLACE_CONTAINER`) с теми же
  ключами и клиентами.
