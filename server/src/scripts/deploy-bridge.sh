#!/bin/bash
set -euo pipefail

# ==============================================================================
# Dementia Panel - установка моста (docs/bridges.md)
#
# Мост — сервер в стране пользователей, который пересылает UDP-трафик AmneziaWG на зарубежную ноду (iptables DNAT).
# Шифрование остаётся сквозным: ключей клиентов на мосту нет. Docker не нужен.
#
# Скрипт передаётся панелью через stdin (не сохраняется на диск) с переменными:
#   RULES_B64 - скрипт правил пересылки (генерирует панель из БД) в base64
# ==============================================================================

export DEBIAN_FRONTEND=noninteractive
umask 077

: "${RULES_B64:?RULES_B64 не задан}"

BRIDGE_DIR="/etc/dementia-bridge"
UNIT="/etc/systemd/system/dementia-bridge.service"

echo "[1/4] Проверка окружения..."
if [ "$EUID" -ne 0 ]; then
  echo "Ошибка: скрипт должен выполняться с правами root (sudo)!"
  exit 1
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "Установка iptables..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y </dev/null
    apt-get install -y iptables </dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y iptables </dev/null || dnf install -y iptables-nft </dev/null
  elif command -v yum >/dev/null 2>&1; then
    yum install -y iptables </dev/null
  else
    echo "Ошибка: iptables не найден, и его не удалось установить"
    exit 1
  fi
fi
if ! command -v getent >/dev/null 2>&1; then
  echo "Ошибка: нет утилиты getent (нужна для адресов нод, заданных доменом)"
  exit 1
fi

echo "[2/4] Включение пересылки пакетов (sysctl)..."
mkdir -p /etc/sysctl.d
printf 'net.ipv4.ip_forward = 1\n' > /etc/sysctl.d/99-dementia-bridge.conf
chmod 644 /etc/sysctl.d/99-dementia-bridge.conf
sysctl -w net.ipv4.ip_forward=1 >/dev/null

echo "[3/4] Правила пересылки..."
mkdir -p "$BRIDGE_DIR"
chmod 700 "$BRIDGE_DIR"
echo "$RULES_B64" | base64 -d > "$BRIDGE_DIR/rules.sh.new"
mv -f "$BRIDGE_DIR/rules.sh.new" "$BRIDGE_DIR/rules.sh"
chmod 700 "$BRIDGE_DIR/rules.sh"
sh "$BRIDGE_DIR/rules.sh"

echo "[4/4] Автозапуск правил после перезагрузки..."
if command -v systemctl >/dev/null 2>&1; then
  cat > "$UNIT" <<EOF
[Unit]
Description=Dementia Panel bridge forwarding rules
After=network-online.target docker.service firewalld.service ufw.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh $BRIDGE_DIR/rules.sh

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$UNIT"
  systemctl daemon-reload
  systemctl enable dementia-bridge.service >/dev/null 2>&1
else
  echo "Предупреждение: systemd не найден — после перезагрузки правила восстановит панель при очередном опросе"
fi

echo "================================================================="
echo "🎉 УСПЕХ: мост настроен"
echo "================================================================="
echo "---DEMENTIA_BRIDGE_OK---"
