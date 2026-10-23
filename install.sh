#!/usr/bin/env bash
set -e

# ==============================================================================
# Demension Panel - Automated Server Deployment Script
# ==============================================================================

# Text formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

clear
echo -e "${CYAN}${BOLD}"
echo "======================================================================"
echo "          DEMENSION PANEL - УСТАНОВОЧНЫЙ СКРИПТ ПАНЕЛИ                "
echo "        Управление инфраструктурой серверов AmneziaWG                 "
echo "======================================================================"
echo -e "${NC}"

# Check root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] Этот скрипт должен быть запущен с правами root (sudo).${NC}"
  exit 1
fi

INSTALL_DIR="/opt/demension-panel"

# 1. System packages & Node.js
echo -e "${CYAN}[1/6] Проверка системных компонентов и Node.js...${NC}"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl git ufw ca-certificates
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl git ca-certificates
fi

# Install Node.js 22 LTS if not installed or older than v20
NEED_NODE=false
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=true
else
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -lt 20 ]; then
    NEED_NODE=true
  fi
fi

if [ "$NEED_NODE" = true ]; then
  echo -e "${YELLOW}Установка Node.js 22 LTS...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs || dnf install -y nodejs
fi
echo -e "${GREEN}✓ Node.js $(node -v) и npm $(npm -v) готовы к работе.${NC}"

# 2. Interactive Prompts
echo -e "\n${CYAN}[2/6] Настройка параметров доступа к панели:${NC}"

# Panel Port
read -p "Выберите порт для панели [по умолчанию 3001]: " INPUT_PORT
PANEL_PORT=${INPUT_PORT:-3001}

# Admin Username
read -p "Логин администратора панели [по умолчанию admin]: " INPUT_USER
PANEL_USER=${INPUT_USER:-admin}

# Admin Password
while true; do
  read -s -p "Пароль администратора панели: " INPUT_PASS
  echo ""
  if [ -z "$INPUT_PASS" ]; then
    echo -e "${RED}Пароль не может быть пустым. Попробуйте еще раз.${NC}"
  else
    read -s -p "Подтвердите пароль администратора: " INPUT_PASS_CONFIRM
    echo ""
    if [ "$INPUT_PASS" = "$INPUT_PASS_CONFIRM" ]; then
      PANEL_PASS="$INPUT_PASS"
      break
    else
      echo -e "${RED}Пароли не совпадают. Попробуйте снова.${NC}"
    fi
  fi
done

# 3. Clone or Update Repository
echo -e "\n${CYAN}[3/6] Развертывание кодовой базы в ${INSTALL_DIR}...${NC}"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Обновление существующей установки..."
  cd "$INSTALL_DIR"
  git pull origin main
else
  if [ -f "$(pwd)/package.json" ] && [ -d "$(pwd)/server" ]; then
    echo "Копирование текущей директории в ${INSTALL_DIR}..."
    mkdir -p "$INSTALL_DIR"
    cp -r ./* "$INSTALL_DIR/" 2>/dev/null || true
    cp -r ./.* "$INSTALL_DIR/" 2>/dev/null || true
  else
    echo "Клонирование репозитория..."
    git clone https://github.com/ghostoftheeleven/demension-panel.git "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
fi

# 4. Install Dependencies and Build
echo -e "\n${CYAN}[4/6] Установка зависимостей и компиляция проектов...${NC}"
cd "$INSTALL_DIR"
npm install --prefix server
npm install --prefix client
npm run build

# Save configuration
mkdir -p "$INSTALL_DIR/data"
cat > "$INSTALL_DIR/server/.env" <<EOF
PORT=${PANEL_PORT}
PANEL_USER=${PANEL_USER}
PANEL_PASSWORD=${PANEL_PASS}
NODE_ENV=production
EOF

# 5. Setup Systemd Service
echo -e "\n${CYAN}[5/6] Создание и запуск системной службы systemd...${NC}"
NODE_PATH=$(which node)

cat > /etc/systemd/system/demension.service <<EOF
[Unit]
Description=Demension Panel - AmneziaWG Management Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/server/.env
ExecStart=${NODE_PATH} ${INSTALL_DIR}/server/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable demension.service
systemctl restart demension.service

# 6. Firewall Configuration
echo -e "\n${CYAN}[6/6] Настройка сетевого экрана (Firewall)...${NC}"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow ${PANEL_PORT}/tcp >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Порт ${PANEL_PORT}/tcp открыт в UFW.${NC}"
fi

# Detect Public IP
SERVER_IP=$(curl -s -4 ifconfig.me || curl -s -4 icanhazip.com || echo "YOUR_SERVER_IP")

echo -e "\n${GREEN}${BOLD}======================================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 УСПЕХ: Demension Panel успешно установлена и запущена!${NC}"
echo -e "${GREEN}${BOLD}======================================================================${NC}"
echo -e "Адрес панели:         ${BOLD}${CYAN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
echo -e "Логин администратора: ${BOLD}${WHITE}${PANEL_USER}${NC}"
echo -e "Пароль:               ${BOLD}${WHITE}********${NC}"
echo -e "Служба systemd:       ${BOLD}systemctl status demension${NC}"
echo -e "Директория:           ${BOLD}${INSTALL_DIR}${NC}"
echo -e "======================================================================"
