#!/bin/bash
set -e

# ==============================================================================
# Demension Panel - AmneziaWG Remote Deployment Script
# ==============================================================================

export DEBIAN_FRONTEND=noninteractive

echo "[1/6] Проверка системных требований и окружения..."
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

echo "[2/6] Проверка и установка Docker..."
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Запуск автоматической установки Docker..."
  if [ "$PM" = "apt" ]; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release iptables
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io
  else
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable docker
  systemctl start docker
  echo "Docker успешно установлен!"
else
  echo "Docker уже установлен: $(docker --version)"
fi

echo "[3/6] Настройка сетевого стека ядра (sysctl)..."
mkdir -p /etc/sysctl.d
cat > /etc/sysctl.d/99-amneziawg.conf <<EOF
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.ipv4.conf.all.src_valid_mark = 1
EOF
sysctl --system >/dev/null 2>&1 || true

echo "[4/6] Загрузка официального образа AmneziaWG..."
CONTAINER_NAME="amnezia-awg"
IMAGE_NAME="amneziavpn/amneziawg-go:latest"

docker pull $IMAGE_NAME

echo "[5/6] Подготовка директорий и конфигурации AmneziaWG..."
mkdir -p /opt/amnezia/awg
cd /opt/amnezia/awg

# Read arguments or environment variables
AWG_PORT=${AWG_PORT:-51820}
AWG_SUBNET=${AWG_SUBNET:-"10.8.0.1/24"}
JC=${AWG_JC:-4}
JMIN=${AWG_JMIN:-40}
JMAX=${AWG_JMAX:-70}
S1=${AWG_S1:-36}
S2=${AWG_S2:-124}
H1=${AWG_H1:-124357689}
H2=${AWG_H2:-987654321}
H3=${AWG_H3:-135792468}
H4=${AWG_H4:-246813579}

# Generate or use passed keys
if [ -z "$AWG_SERVER_PRIV_KEY" ]; then
  echo "Генерация новых ключей сервера..."
  AWG_SERVER_PRIV_KEY=$(docker run --rm $IMAGE_NAME awg genkey)
fi

AWG_SERVER_PUB_KEY=$(echo "$AWG_SERVER_PRIV_KEY" | docker run --rm -i $IMAGE_NAME awg pubkey)

if [ -z "$AWG_PSK" ]; then
  AWG_PSK=$(docker run --rm $IMAGE_NAME awg genpsk)
fi

echo "$AWG_SERVER_PRIV_KEY" > /opt/amnezia/awg/wireguard_server_private_key.key
echo "$AWG_SERVER_PUB_KEY" > /opt/amnezia/awg/wireguard_server_public_key.key
echo "$AWG_PSK" > /opt/amnezia/awg/wireguard_psk.key
chmod 600 /opt/amnezia/awg/*.key

# Determine default WAN interface for NAT
WAN_IFACE=$(ip route get 8.8.8.8 2>/dev/null | awk '{print $5; exit}')
if [ -z "$WAN_IFACE" ]; then
  WAN_IFACE="eth0"
fi
echo "Основной сетевой интерфейс: $WAN_IFACE"

# Generate awg0.conf
cat > /opt/amnezia/awg/awg0.conf <<EOF
[Interface]
PrivateKey = $AWG_SERVER_PRIV_KEY
Address = $AWG_SUBNET
ListenPort = $AWG_PORT
Jc = $JC
Jmin = $JMIN
Jmax = $JMAX
S1 = $S1
S2 = $S2
H1 = $H1
H2 = $H2
H3 = $H3
H4 = $H4
EOF

# Create startup script for inside the container
cat > /opt/amnezia/awg/start.sh <<'EOF'
#!/bin/bash
set -e

# Stop existing interface if any
awg-quick down /opt/amnezia/awg/awg0.conf 2>/dev/null || true

# Start AmneziaWG interface
awg-quick up /opt/amnezia/awg/awg0.conf

# Setup forwarding & NAT
iptables -A INPUT -i awg0 -j ACCEPT
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A OUTPUT -o awg0 -j ACCEPT
iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow forwarding from awg0 to any outgoing interface
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -j MASQUERADE

echo "AmneziaWG interface awg0 started successfully inside container."
tail -f /dev/null
EOF
chmod +x /opt/amnezia/awg/start.sh

# Stop and remove existing container if running
if docker ps -a --format '{{.Names}}' | grep -Eq "^${CONTAINER_NAME}\$"; then
  echo "Остановка и удаление старого контейнера $CONTAINER_NAME..."
  docker stop $CONTAINER_NAME >/dev/null 2>&1 || true
  docker rm $CONTAINER_NAME >/dev/null 2>&1 || true
fi

echo "[6/6] Запуск контейнера $CONTAINER_NAME..."
docker run -d \
  --name $CONTAINER_NAME \
  --restart always \
  --privileged \
  --cap-add=NET_ADMIN \
  --cap-add=SYS_MODULE \
  -p ${AWG_PORT}:${AWG_PORT}/udp \
  -v /lib/modules:/lib/modules:ro \
  -v /opt/amnezia/awg:/opt/amnezia/awg \
  --sysctl="net.ipv4.conf.all.src_valid_mark=1" \
  --sysctl="net.ipv4.ip_forward=1" \
  --entrypoint "/opt/amnezia/awg/start.sh" \
  $IMAGE_NAME

sleep 2

# Verify awg status inside container
if docker exec $CONTAINER_NAME awg show awg0 >/dev/null 2>&1; then
  echo "================================================================="
  echo "🎉 УСПЕХ: AmneziaWG успешно запущен и работает!"
  echo "================================================================="
else
  echo "Внимание: Интерфейс запускается, проверяем логи..."
  docker logs $CONTAINER_NAME | tail -n 10
fi

# Print machine-readable JSON for Demension Panel
cat <<JSON_END
---DEMENSION_RESULT_START---
{
  "status": "success",
  "serverPublicKey": "$AWG_SERVER_PUB_KEY",
  "presharedKey": "$AWG_PSK",
  "port": $AWG_PORT,
  "subnet": "$AWG_SUBNET",
  "jc": $JC,
  "jmin": $JMIN,
  "jmax": $JMAX,
  "s1": $S1,
  "s2": $S2,
  "h1": $H1,
  "h2": $H2,
  "h3": $H3,
  "h4": $H4
}
---DEMENSION_RESULT_END---
JSON_END
