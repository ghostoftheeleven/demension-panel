#!/bin/bash
# Общая подготовка контейнера для проверок install.sh (подключается через source из in-container.sh и migration-*.sh):
# копия исходников в /work, подставные systemctl и docker, утилиты для проверок.

mkdir -p /work && cd /src && tar cf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=data . | tar xf - -C /work
# Исходники, как у клона обычного пользователя, не принадлежат root (так же в CI) — install.sh работает от root
chown -R 1000:1000 /work

# --- подставной systemctl: запоминает вызовы и запускает/останавливает службу по unit-файлу ---
cat > /usr/local/bin/systemctl <<'SHIM'
#!/bin/bash
echo "systemctl $*" >> /var/log/systemctl-shim.log
UNIT=/etc/systemd/system/demension.service
case "$1" in
  stop) pkill -f "dist/index.js" 2>/dev/null || true ;;
  restart|start)
    if [ "${2:-}" = "demension.service" ] && [ -f "$UNIT" ]; then
      pkill -f "dist/index.js" 2>/dev/null || true
      sleep 1
      WD=$(sed -n 's/^WorkingDirectory=//p' "$UNIT")
      ENVF=$(sed -n 's/^EnvironmentFile=//p' "$UNIT")
      EXEC=$(sed -n 's/^ExecStart=//p' "$UNIT")
      # setsid: служба не должна зависеть от терминала, из которого её запустили (в проверках интерактивного режима это pty)
      (cd "$WD" && set -a && . "$ENVF" && set +a && umask 077 && setsid nohup $EXEC >> /var/log/demension.log 2>&1 < /dev/null &)
    fi ;;
  is-active) pgrep -f "dist/index.js" >/dev/null ;;
esac
exit 0
SHIM
chmod +x /usr/local/bin/systemctl

# --- подставной docker: на «сервере» уже есть контейнер приложения Amnezia ---
cat > /usr/local/bin/docker <<'SHIM'
#!/bin/bash
if [ "$1" = "ps" ]; then
  echo "amnezia-awg (amneziavpn/amnezia-awg:latest)"
  echo "amnezia-xray (amneziavpn/amnezia-xray:latest)"
fi
exit 0
SHIM
chmod +x /usr/local/bin/docker

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq iproute2 netcat-openbsd >/dev/null 2>&1   # ss и nc для проверок; сам install.sh ставит curl/git

section() { echo; echo "################ $*"; }
fail() { echo "ТЕСТ ПРОВАЛЕН: $*"; FAILED=1; }
FAILED=0
