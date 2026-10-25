#!/usr/bin/env bash
# Сквозная проверка install.sh в чистом Ubuntu 24.04 (нужен Docker и интернет): настоящие apt, Node.js из NodeSource, npm ci,
# сборка и запуск службы. Подменены только systemctl (в контейнере нет systemd) и docker (имитирует контейнеры Amnezia на
# сервере).
#
# 1. in-container.sh — установка: случайные логин/пароль и вывод данных подключения, обновление без смены учётных данных,
#    PANEL_RESET_CREDENTIALS, свои значения, занятый порт, отсутствие пароля в .env/журнале, CLI сброса пароля, сохранение
#    переменных .env при обновлении и обновление из git (при ошибке git pull панель продолжает работать).
# 2. migration-old.sh + migration-new.sh — перенос панели между двумя контейнерами одной сети: неверный код, перенос данных,
#    прежние логин и пароль, ключ шифрования, заморозка прежней панели и перенаправление её подписок, интерактивный режим в
#    терминале (pty-drive.py), отказ заменить данные, обновление панели с HTTPS.
# 3. upgrade.sh — обновление работающей панели предыдущего релиза (тег v0.1.0) с данными, HTTPS и своим .env до текущей версии.
#
#   server/test/install/run.sh          (≈ 20 минут)
#   SKIP_MIGRATION=1 server/test/install/run.sh      только установка (≈ 5 минут)
#   SKIP_INSTALL=1 server/test/install/run.sh        без первой части; SKIP_UPGRADE=1 — без обновления с предыдущего релиза
set -uo pipefail

# Git Bash на Windows превращает аргументы вида /tmp/файл в Windows-пути, в том числе у docker exec
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then ROOT="$(cygpath -m "$ROOT")"; fi

STATUS=0
docker_run() { docker run -v "$ROOT:/src:ro" -v "$ROOT/server/test/install:/harness:ro" "$@"; }

if [ "${SKIP_INSTALL:-}" != 1 ]; then
  docker_run --rm ubuntu:24.04 bash /harness/in-container.sh || STATUS=1
fi

if [ "${SKIP_MIGRATION:-}" != 1 ]; then
  NET="demension-migration-$$"
  OLD="mig-old-$$"
  cleanup() {
    docker rm -f "$OLD" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  docker network create "$NET" >/dev/null

  echo
  echo "################ Перенос панели: подготовка прежнего сервера"
  # Имя mig-old — адрес прежней панели для нового сервера (migration-new.sh)
  docker_run -d --name "$OLD" --network "$NET" --network-alias mig-old ubuntu:24.04 bash /harness/migration-old.sh >/dev/null

  READY=0
  for _ in $(seq 1 240); do
    if docker exec "$OLD" test -f /tmp/old-ready 2>/dev/null; then READY=1; break; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$OLD" 2>/dev/null)" != true ]; then break; fi
    sleep 5
  done
  if [ "$READY" != 1 ]; then
    docker logs "$OLD" 2>&1 | tail -60
    echo "ТЕСТ ПРОВАЛЕН: прежняя панель не подготовлена к переносу"
    exit 1
  fi

  CODE="$(docker exec "$OLD" cat /tmp/migration-code | tr -d '[:space:]')"
  AUTH="$(docker exec "$OLD" cat /tmp/migration-auth | tr -d '[:space:]')"
  SECRET_KEY="$(docker exec "$OLD" cat /tmp/old-secret-key | tr -d '[:space:]')"
  SUB_TOKEN="$(docker exec "$OLD" cat /tmp/sub-token | tr -d '[:space:]')"

  echo
  echo "################ Перенос панели: новый сервер"
  docker_run --rm --network "$NET" \
    -e MIGRATION_CODE="$CODE" -e MIGRATION_AUTH="$AUTH" -e EXPECT_SECRET_KEY="$SECRET_KEY" -e EXPECT_SUB_TOKEN="$SUB_TOKEN" \
    ubuntu:24.04 bash /harness/migration-new.sh || STATUS=1

  echo
  echo "################ Перенос панели: состояние прежнего сервера после переноса"
  LOGIN_STATUS="$(docker exec "$OLD" curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3001/api/auth/login -H 'Content-Type: application/json' -d '{"username":"old.admin","password":"OldAdminPass-123"}')"
  SUB_REPLY="$(docker exec "$OLD" curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:3001/sub/$SUB_TOKEN")"
  echo "вход на прежней панели: HTTP $LOGIN_STATUS (ожидается 410)"
  echo "подписка на прежней панели: $SUB_REPLY (ожидается 308 и адрес новой панели)"
  [ "$LOGIN_STATUS" = 410 ] || { echo "ТЕСТ ПРОВАЛЕН: прежняя панель не заморожена"; STATUS=1; }
  case "$SUB_REPLY" in
    "308 http://"*":3001/sub/$SUB_TOKEN") ;;
    *) echo "ТЕСТ ПРОВАЛЕН: подписка прежней панели не перенаправлена на новую"; STATUS=1 ;;
  esac
fi

if [ "${SKIP_UPGRADE:-}" != 1 ]; then
  echo
  echo "################ Обновление работающей панели предыдущего релиза"
  docker_run --rm ubuntu:24.04 bash /harness/upgrade.sh || STATUS=1
fi

exit "$STATUS"
