#!/bin/bash
set -euo pipefail

# ==============================================================================
# Demension Panel - AmneziaWG Remote Deployment Script
#
# Скрипт передаётся панелью через stdin (не сохраняется на диск) с переменными:
#   AWG_PORT      - UDP-порт AmneziaWG
#   AWG_NETWORK   - адрес сети туннеля (для NAT), например 10.8.0.0/24
#   AWG_CONF_B64  - полный awg0.conf (интерфейс + пиры) в base64
#   AWG_IMAGE     - Docker-образ AmneziaWG
#   PANEL_IP      - IP панели (исключается из блокировок fail2ban)
# ==============================================================================

export DEBIAN_FRONTEND=noninteractive
umask 077

: "${AWG_PORT:?AWG_PORT не задан}"
: "${AWG_NETWORK:?AWG_NETWORK не задан}"
: "${AWG_CONF_B64:?AWG_CONF_B64 не задан}"

CONTAINER_NAME="amnezia-awg"
IMAGE_NAME="${AWG_IMAGE:-amneziavpn/amneziawg-go:0.2.19}"
PANEL_IP="${PANEL_IP:-}"
AWG_DIR="/opt/amnezia/awg"

echo "[1/7] Проверка системных требований и окружения..."
if [ "$EUID" -ne 0 ]; then
  echo "Ошибка: скрипт должен выполняться с правами root (sudo)!"
  exit 1
fi

# Detect package manager
if command -v apt-get >/dev/null 2>&1; then
  PM="apt"
elif command -v dnf >/dev/null 2>&1; then
  PM="dnf"
elif command -v yum >/dev/null 2>&1; then
  PM="yum"
else
  echo "Предупреждение: неизвестный менеджер пакетов. Попытка продолжить..."
  PM="unknown"
fi

ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; then
  echo "Ошибка: архитектура $ARCH не поддерживается — образ $IMAGE_NAME собран только для amd64."
  exit 1
fi

echo "[2/7] Проверка и установка Docker..."
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Запуск автоматической установки Docker..."
  if [ "$PM" = "apt" ]; then
    apt-get update -y </dev/null
    apt-get install -y ca-certificates curl gnupg </dev/null
    install -m 0755 -d /etc/apt/keyrings
    OS_ID=$(. /etc/os-release && echo "$ID")
    OS_CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
    # Производные дистрибутивы (Mint, Pop!_OS и т.п.) используют репозиторий родительского
    case "$OS_ID" in
      ubuntu|debian) ;;
      *) if grep -qi ubuntu /etc/os-release; then OS_ID=ubuntu; else OS_ID=debian; fi ;;
    esac
    curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS_ID} ${OS_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
    chmod 644 /etc/apt/sources.list.d/docker.list
    apt-get update -y </dev/null
    apt-get install -y docker-ce docker-ce-cli containerd.io </dev/null
  elif [ "$PM" = "dnf" ] || [ "$PM" = "yum" ]; then
    # get.docker.com не поддерживает AlmaLinux — подключаем репозиторий Docker CE для EL
    $PM install -y dnf-plugins-core </dev/null >/dev/null 2>&1 || $PM install -y yum-utils </dev/null >/dev/null 2>&1 || true
    if command -v dnf >/dev/null 2>&1; then
      dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    else
      yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    fi
    $PM install -y docker-ce docker-ce-cli containerd.io </dev/null
  else
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker
  echo "Docker успешно установлен!"
else
  echo "Docker уже установлен: $(docker --version)"
fi

echo "[3/7] Настройка сетевого стека ядра (sysctl)..."
mkdir -p /etc/sysctl.d
cat > /etc/sysctl.d/99-amneziawg.conf <<EOF
net.ipv4.ip_forward = 1
net.ipv4.conf.all.src_valid_mark = 1
EOF
chmod 644 /etc/sysctl.d/99-amneziawg.conf
sysctl -p /etc/sysctl.d/99-amneziawg.conf >/dev/null 2>&1 || true

echo "[4/7] Загрузка официального образа AmneziaWG..."
docker pull "$IMAGE_NAME"

echo "[5/7] Подготовка конфигурации AmneziaWG..."
mkdir -p "$AWG_DIR"
chmod 700 "$AWG_DIR"
echo "$AWG_CONF_B64" | base64 -d > "$AWG_DIR/awg0.conf.new"
mv -f "$AWG_DIR/awg0.conf.new" "$AWG_DIR/awg0.conf"
printf 'AWG_NETWORK=%s\nAWG_PORT=%s\n' "$AWG_NETWORK" "$AWG_PORT" > "$AWG_DIR/demension.env"
# Устаревшие файлы ключей от предыдущих версий панели
rm -f "$AWG_DIR"/wireguard_*.key

# Скрипт запуска внутри контейнера (POSIX sh: образ может не содержать bash).
# Правила iptables добавляются идемпотентно, чтобы не дублироваться при перезапусках.
cat > "$AWG_DIR/start.sh" <<'EOF'
#!/bin/sh
set -e
. /opt/amnezia/awg/demension.env

rule() {
  table="$1"; shift
  iptables -t "$table" -C "$@" 2>/dev/null || iptables -t "$table" -A "$@"
}

awg-quick down /opt/amnezia/awg/awg0.conf 2>/dev/null || true
awg-quick up /opt/amnezia/awg/awg0.conf

rule filter INPUT -i awg0 -j ACCEPT
rule filter FORWARD -i awg0 -j ACCEPT
rule filter OUTPUT -o awg0 -j ACCEPT
rule filter FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT
rule nat POSTROUTING -s "$AWG_NETWORK" -j MASQUERADE

echo "AmneziaWG interface awg0 started (network $AWG_NETWORK, port $AWG_PORT)."
trap 'awg-quick down /opt/amnezia/awg/awg0.conf; exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
EOF
chmod 700 "$AWG_DIR/start.sh"

if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
  echo "Остановка и удаление старого контейнера $CONTAINER_NAME..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

echo "[6/7] Запуск контейнера $CONTAINER_NAME..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart always \
  --cap-add=NET_ADMIN \
  --cap-add=SYS_MODULE \
  --device /dev/net/tun:/dev/net/tun \
  -p "${AWG_PORT}:${AWG_PORT}/udp" \
  -v /lib/modules:/lib/modules:ro \
  -v "$AWG_DIR:$AWG_DIR" \
  --sysctl="net.ipv4.conf.all.src_valid_mark=1" \
  --sysctl="net.ipv4.ip_forward=1" \
  --entrypoint "$AWG_DIR/start.sh" \
  "$IMAGE_NAME" >/dev/null

# Открытие UDP-порта в активном фаерволе хоста
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${AWG_PORT}/udp" >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${AWG_PORT}/udp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo "[7/7] Настройка защиты SSH от перебора паролей (fail2ban)..."
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if [ "$PM" = "apt" ]; then
    apt-get install -y fail2ban </dev/null || true
  elif [ "$PM" = "dnf" ] || [ "$PM" = "yum" ]; then
    $PM install -y epel-release </dev/null >/dev/null 2>&1 || true
    $PM install -y fail2ban </dev/null || true
  fi
fi

if command -v fail2ban-client >/dev/null 2>&1; then
  SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')
  SSH_PORT=${SSH_PORT:-ssh}
  if [ -f /var/log/auth.log ] || [ -f /var/log/secure ]; then BACKEND=auto; else BACKEND=systemd; fi
  IGNORE_IP="127.0.0.1/8 ::1"
  case "$PANEL_IP" in
    *[!0-9a-fA-F.:]*|"") ;;
    *) IGNORE_IP="$IGNORE_IP $PANEL_IP" ;;
  esac
  mkdir -p /etc/fail2ban/jail.d
  cat > /etc/fail2ban/jail.d/demension-sshd.local <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
backend = ${BACKEND}
ignoreip = ${IGNORE_IP}
maxretry = 4
findtime = 600
bantime = 86400
EOF
  chmod 644 /etc/fail2ban/jail.d/demension-sshd.local
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban >/dev/null 2>&1 || true
  echo "✓ Защита SSH (fail2ban) активирована (порт ${SSH_PORT}, maxretry=4, bantime=24h)"
fi

# Ожидание поднятия интерфейса
for i in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$CONTAINER_NAME" awg show awg0 >/dev/null 2>&1; then
    echo "================================================================="
    echo "🎉 УСПЕХ: AmneziaWG успешно запущен и работает!"
    echo "================================================================="
    echo "---DEMENSION_OK---"
    exit 0
  fi
  sleep 2
done

echo "Ошибка: интерфейс awg0 не поднялся. Логи контейнера:"
docker logs --tail 30 "$CONTAINER_NAME" 2>&1 || true
exit 1
