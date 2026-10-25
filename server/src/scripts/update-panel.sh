#!/usr/bin/env bash
# Обновление панели из интерфейса (docs/releases.md). Запускается панелью через systemd-run отдельной службой
# demension-update: install.sh останавливает demension.service, и процесс обновления не должен остановиться вместе с ней.
#
#   update-panel.sh КАТАЛОГ_ПАНЕЛИ КАТАЛОГ_СОСТОЯНИЯ ВЕРСИЯ ТЕКУЩАЯ_ВЕРСИЯ
#
# 1. Скачивает тег релиза и берёт install.sh из него (новая версия сама знает, как себя установить).
# 2. Запускает install.sh без терминала с PANEL_UPDATE_REF=ВЕРСИЯ: резервная копия БД, сборка, перезапуск, проверка запуска.
#    Логин, пароль, порт, .env и данные не меняются — как при обновлении из терминала.
# 3. Если установка не удалась после смены кода — откат: прежний коммит, БД из резервной копии этого обновления, сборка, запуск.
# Состояние — КАТАЛОГ_СОСТОЯНИЯ/status.json (его читает панель), журнал — update.log там же.
set -uo pipefail

INSTALL_DIR="$1"
STATE_DIR="$2"
TARGET="$3"
FROM="$4"

STATUS_FILE="$STATE_DIR/status.json"
LOG_FILE="$STATE_DIR/update.log"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
VERSION_RE='^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$'

if ! [[ "$TARGET" =~ $VERSION_RE ]]; then echo "Некорректная версия: $TARGET" >&2; exit 2; fi
if ! [[ "$FROM" =~ $VERSION_RE ]]; then FROM="unknown"; fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
umask 077

write_status() { # write_status СОСТОЯНИЕ "сообщение" — сообщения только из этого файла, без кавычек и переводов строк
  local finished="null"
  if [ "$1" != running ]; then finished="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""; fi
  printf '{"state":"%s","from":"%s","to":"%s","started_at":"%s","finished_at":%s,"message":"%s"}\n' \
    "$1" "$FROM" "$TARGET" "$STARTED_AT" "$finished" "$2" > "$STATUS_FILE.tmp"
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

: > "$LOG_FILE"
exec >> "$LOG_FILE" 2>&1 < /dev/null
write_status running "Обновление до $TARGET"
echo "=== Обновление панели $FROM → $TARGET ($STARTED_AT)"

git_() { git -c safe.directory="$INSTALL_DIR" -C "$INSTALL_DIR" "$@"; }

panel_port() { # порт из server/.env (по умолчанию 3001)
  local port
  port="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}PORT[[:space:]]*=[[:space:]]*\([0-9]\{1,5\}\).*/\2/p' "$INSTALL_DIR/server/.env" 2>/dev/null | head -n1)"
  printf '%s' "${port:-3001}"
}

panel_up() { # ждёт ответа /api/health до 60 секунд
  local port
  port="$(panel_port)"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

ensure_running() { # панель не должна остаться остановленной
  if ! systemctl is-active --quiet demension.service; then systemctl start demension.service || true; fi
}

OLD_REV="$(git_ rev-parse HEAD 2>/dev/null || true)"
if [ -z "$OLD_REV" ]; then
  write_status failed "Каталог панели не является клоном git: обновите панель командой установки из терминала"
  exit 1
fi

echo "--- Получение релиза $TARGET"
if ! git_ fetch --no-tags origin "+refs/tags/${TARGET}:refs/tags/${TARGET}" \
  || ! git_ show "refs/tags/${TARGET}:install.sh" > "$STATE_DIR/install.sh"; then
  ensure_running
  write_status failed "Не удалось скачать релиз $TARGET с GitHub. Панель работает на прежней версии"
  exit 1
fi

# Резервные копии БД, которые install.sh сделает в этом запуске, — с отметкой времени не раньше этой
START_STAMP="$(date +%Y%m%d-%H%M%S)"

echo "--- Установка $TARGET (install.sh)"
(cd "$INSTALL_DIR" && PANEL_UPDATE_REF="$TARGET" bash "$STATE_DIR/install.sh")
RC=$?
rm -f "$STATE_DIR/install.sh"

if [ "$RC" = 0 ] && panel_up; then
  echo "=== Панель обновлена до $TARGET"
  write_status success "Панель обновлена до $TARGET"
  exit 0
fi
echo "=== install.sh завершился с кодом $RC"

NEW_REV="$(git_ rev-parse HEAD 2>/dev/null || true)"
if [ "$NEW_REV" = "$OLD_REV" ]; then
  # Код не менялся (не скачался релиз, локальные правки): прежняя версия цела, достаточно убедиться, что она запущена
  ensure_running
  write_status failed "Обновление не выполнено, код панели не менялся. Подробности в журнале"
  exit 1
fi

echo "--- Откат на прежнюю версию ($OLD_REV)"
write_status running "Обновление не удалось, откат на $FROM"
systemctl stop demension.service || true
git_ reset --hard "$OLD_REV"

# БД — из резервной копии этого обновления (install.sh копирует её после остановки службы): новая версия могла изменить схему
BACKUP=""
for f in "$INSTALL_DIR"/data/backups/demension.db.*; do
  [ -f "$f" ] || continue
  stamp="${f##*/demension.db.}"
  if [[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]] && [[ ! "$stamp" < "$START_STAMP" ]]; then BACKUP="$stamp"; fi
done
if [ -n "$BACKUP" ]; then
  rm -f "$INSTALL_DIR/data/demension.db-wal" "$INSTALL_DIR/data/demension.db-shm"
  for suffix in "" "-wal" "-shm"; do
    if [ -f "$INSTALL_DIR/data/backups/demension.db${suffix}.$BACKUP" ]; then
      cp -a "$INSTALL_DIR/data/backups/demension.db${suffix}.$BACKUP" "$INSTALL_DIR/data/demension.db${suffix}"
    fi
  done
  echo "БД восстановлена из резервной копии $BACKUP"
fi

ROLLBACK_OK=false
if (cd "$INSTALL_DIR" && npm ci --prefix server && npm ci --prefix client && npm run build); then
  systemctl restart demension.service || true
  if panel_up; then ROLLBACK_OK=true; fi
fi

if [ "$ROLLBACK_OK" = true ]; then
  echo "=== Откат выполнен: панель работает на $FROM"
  write_status rolled_back "Обновление до $TARGET не удалось, панель возвращена на $FROM. Подробности в журнале"
  exit 1
fi
ensure_running
echo "=== Откат не удался"
write_status failed "Обновление и откат не удались. Обновите панель командой установки из терминала"
exit 1
