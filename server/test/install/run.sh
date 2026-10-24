#!/usr/bin/env bash
# Сквозная проверка install.sh в чистом Ubuntu 24.04 (нужен Docker и интернет): настоящие apt, Node.js из NodeSource, npm ci,
# сборка и запуск службы. Подменены только systemctl (в контейнере нет systemd) и docker (имитирует контейнеры Amnezia на
# сервере). Проверяет случайные логин/пароль и вывод данных подключения, обновление без смены учётных данных,
# PANEL_RESET_CREDENTIALS, свои значения, занятый порт, отсутствие пароля в .env/журнале, CLI сброса пароля, сохранение
# переменных .env при обновлении и обновление из git (при ошибке git pull панель продолжает работать).
#
#   server/test/install/run.sh          (≈ 4–6 минут)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then ROOT="$(cygpath -m "$ROOT")"; fi

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOT:/src:ro" \
  -v "$ROOT/server/test/install:/harness:ro" \
  ubuntu:24.04 bash /harness/in-container.sh
