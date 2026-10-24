#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Demension Panel - Automated Server Deployment Script
#
# Интерактивно:      curl -sSL .../install.sh | sudo bash
# Без вопросов:      curl -sSL .../install.sh | sudo PANEL_PORT=3001 PANEL_USER=admin PANEL_PASSWORD='...' bash
# ==============================================================================

# Text formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

INSTALL_DIR="/opt/demension-panel"
REPO_URL="https://github.com/ghostoftheeleven/demension-panel.git"
MIN_NODE="22.13.0"

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

# При запуске через `curl | bash` stdin занят самим скриптом — вопросы задаём через терминал
if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  TTY=/dev/tty
else
  TTY=""
fi

ask() { # ask VAR "Вопрос" "по умолчанию"
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=""
  if [ -n "${!__var:-}" ]; then return; fi
  if [ -n "$TTY" ]; then
    read -r -p "$__prompt" __reply < "$TTY"
  fi
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

ask_secret() { # ask_secret VAR "Вопрос"
  local __var="$1" __prompt="$2" __first="" __second=""
  if [ -n "${!__var:-}" ]; then return; fi
  if [ -z "$TTY" ]; then
    echo -e "${RED}[ERROR] Нет терминала для ввода пароля. Передайте PANEL_PASSWORD через окружение.${NC}"
    exit 1
  fi
  while true; do
    read -r -s -p "$__prompt" __first < "$TTY"; echo ""
    if [ ${#__first} -lt 8 ]; then
      echo -e "${RED}Пароль должен содержать не менее 8 символов.${NC}"
      continue
    fi
    read -r -s -p "Подтвердите пароль: " __second < "$TTY"; echo ""
    if [ "$__first" = "$__second" ]; then
      printf -v "$__var" '%s' "$__first"
      return
    fi
    echo -e "${RED}Пароли не совпадают. Попробуйте снова.${NC}"
  done
}

version_ge() { # version_ge 22.13.0 22.5.1
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# 1. System packages & Node.js
echo -e "${CYAN}[1/7] Проверка системных компонентов и Node.js...${NC}"
if command -v apt-get >/dev/null 2>&1; then
  PM=apt
  apt-get update -y
  apt-get install -y curl git ca-certificates
elif command -v dnf >/dev/null 2>&1; then
  PM=dnf
  dnf install -y curl git ca-certificates tar
else
  echo -e "${RED}[ERROR] Поддерживаются дистрибутивы на базе Debian/Ubuntu и RHEL/AlmaLinux.${NC}"
  exit 1
fi

NEED_NODE=true
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE=$(node -v | sed 's/^v//')
  if version_ge "$CURRENT_NODE" "$MIN_NODE"; then
    NEED_NODE=false
  fi
fi

if [ "$NEED_NODE" = true ]; then
  echo -e "${YELLOW}Установка Node.js 22 LTS (требуется ≥ ${MIN_NODE})...${NC}"
  if [ "$PM" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  fi
  CURRENT_NODE=$(node -v | sed 's/^v//')
  if ! version_ge "$CURRENT_NODE" "$MIN_NODE"; then
    echo -e "${RED}[ERROR] Установлен Node.js ${CURRENT_NODE}, требуется ≥ ${MIN_NODE}.${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}✓ Node.js $(node -v) и npm $(npm -v) готовы к работе.${NC}"

# 2. Detect existing installation
UPDATE=false
if [ -f "$INSTALL_DIR/server/package.json" ]; then
  UPDATE=true
fi

# 3. Interactive Prompts
echo -e "\n${CYAN}[2/7] Настройка параметров доступа к панели:${NC}"
CURRENT_PORT=""
if [ -f "$INSTALL_DIR/server/.env" ]; then
  CURRENT_PORT=$(grep -E '^PORT=' "$INSTALL_DIR/server/.env" | cut -d= -f2 || true)
fi
ask PANEL_PORT "Порт панели [${CURRENT_PORT:-3001}]: " "${CURRENT_PORT:-3001}"
if ! [[ "$PANEL_PORT" =~ ^[0-9]+$ ]] || [ "$PANEL_PORT" -lt 1 ] || [ "$PANEL_PORT" -gt 65535 ]; then
  echo -e "${RED}[ERROR] Некорректный порт: ${PANEL_PORT}${NC}"
  exit 1
fi

SET_CREDENTIALS=true
if [ "$UPDATE" = true ] && [ -z "${PANEL_PASSWORD:-}" ]; then
  CHANGE_CREDS=""
  ask CHANGE_CREDS "Обнаружена установленная панель. Сменить логин/пароль администратора? [y/N]: " "n"
  case "$CHANGE_CREDS" in
    y|Y|yes|д|Д) ;;
    *) SET_CREDENTIALS=false ;;
  esac
fi

if [ "$SET_CREDENTIALS" = true ]; then
  ask PANEL_USER "Логин администратора [admin]: " "admin"
  ask_secret PANEL_PASSWORD "Пароль администратора (не менее 8 символов): "
  if [ ${#PANEL_PASSWORD} -lt 8 ]; then
    echo -e "${RED}[ERROR] Пароль должен содержать не менее 8 символов.${NC}"
    exit 1
  fi
fi

# 4. Clone or Update Repository
echo -e "\n${CYAN}[3/7] Развертывание кодовой базы в ${INSTALL_DIR}...${NC}"
if [ "$UPDATE" = true ]; then
  systemctl stop demension.service 2>/dev/null || true
  if [ -f "$INSTALL_DIR/data/demension.db" ]; then
    BACKUP_DIR="$INSTALL_DIR/data/backups"
    mkdir -p "$BACKUP_DIR"
    STAMP=$(date +%Y%m%d-%H%M%S)
    for f in "$INSTALL_DIR"/data/demension.db*; do
      cp -a "$f" "$BACKUP_DIR/$(basename "$f").$STAMP"
    done
    chmod -R go-rwx "$BACKUP_DIR"
    echo -e "${GREEN}✓ Резервная копия БД: ${BACKUP_DIR}/demension.db.${STAMP}${NC}"
  fi
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Обновление существующей установки..."
  git -C "$INSTALL_DIR" pull --ff-only origin main
elif [ -f "$(pwd)/package.json" ] && [ -d "$(pwd)/server" ] && [ "$(pwd)" != "$INSTALL_DIR" ]; then
  echo "Копирование текущей директории в ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  # ./. копирует содержимое каталога, включая скрытые файлы, но не родительский каталог
  cp -a ./. "$INSTALL_DIR/"
  rm -rf "$INSTALL_DIR/server/node_modules" "$INSTALL_DIR/client/node_modules"
elif [ ! -f "$INSTALL_DIR/server/package.json" ]; then
  echo "Клонирование репозитория..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 5. Install Dependencies and Build
echo -e "\n${CYAN}[4/7] Установка зависимостей и компиляция проектов...${NC}"
npm ci --prefix server
npm ci --prefix client
npm run build

mkdir -p "$INSTALL_DIR/data"
chmod 700 "$INSTALL_DIR/data"

# Пароль в .env не хранится: учётные данные записываются сразу в БД (только хэш)
umask 077
cat > "$INSTALL_DIR/server/.env" <<EOF
PORT=${PANEL_PORT}
NODE_ENV=production
EOF
chmod 600 "$INSTALL_DIR/server/.env"

if [ "$SET_CREDENTIALS" = true ]; then
  PANEL_USER="$PANEL_USER" PANEL_PASSWORD="$PANEL_PASSWORD" node "$INSTALL_DIR/server/dist/cli/reset-admin.js"
fi
unset PANEL_PASSWORD

# 6. Setup Systemd Service
echo -e "\n${CYAN}[5/7] Создание и запуск системной службы systemd...${NC}"
NODE_BIN=$(command -v node)

cat > /etc/systemd/system/demension.service <<EOF
[Unit]
Description=Demension Panel - AmneziaWG Management Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/server/.env
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server/dist/index.js
Restart=always
RestartSec=5
UMask=0077
PrivateTmp=true
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
EOF
chmod 644 /etc/systemd/system/demension.service

systemctl daemon-reload
systemctl enable demension.service
systemctl restart demension.service

# 7. Firewall Configuration
echo -e "\n${CYAN}[6/7] Настройка сетевого экрана (Firewall)...${NC}"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Порт ${PANEL_PORT}/tcp открыт в UFW.${NC}"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Порт ${PANEL_PORT}/tcp открыт в firewalld.${NC}"
else
  echo "Активный фаервол не обнаружен — порт ${PANEL_PORT}/tcp открывать не требуется."
fi
echo -e "${YELLOW}Для выпуска сертификата Let's Encrypt методом HTTP-01 должен быть доступен порт 80/tcp.${NC}"

# 8. Fail2ban SSH Protection
echo -e "\n${CYAN}[7/7] Настройка защиты SSH от перебора (Fail2ban)...${NC}"
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if [ "$PM" = apt ]; then
    apt-get install -y fail2ban || true
  else
    dnf install -y epel-release || true
    dnf install -y fail2ban || true
  fi
fi

if command -v fail2ban-client >/dev/null 2>&1; then
  SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')
  SSH_PORT=${SSH_PORT:-ssh}
  if [ -f /var/log/auth.log ] || [ -f /var/log/secure ]; then BACKEND=auto; else BACKEND=systemd; fi
  mkdir -p /etc/fail2ban/jail.d
  cat > /etc/fail2ban/jail.d/demension-sshd.local <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
filter = sshd
backend = ${BACKEND}
maxretry = 4
findtime = 600
bantime = 86400
EOF
  chmod 644 /etc/fail2ban/jail.d/demension-sshd.local
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Защита SSH (Fail2ban) активирована (порт ${SSH_PORT}, maxretry=4, bantime=24ч).${NC}"
fi

# Detect Public IP
SERVER_IP=$(curl -s -4 --max-time 5 ifconfig.me || curl -s -4 --max-time 5 icanhazip.com || echo "YOUR_SERVER_IP")

echo -e "\n${GREEN}${BOLD}======================================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 УСПЕХ: Demension Panel успешно установлена и запущена!${NC}"
echo -e "${GREEN}${BOLD}======================================================================${NC}"
echo -e "Адрес панели:         ${BOLD}${CYAN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
if [ "$SET_CREDENTIALS" = true ]; then
  echo -e "Логин администратора: ${BOLD}${PANEL_USER}${NC}"
fi
echo -e "Служба systemd:       ${BOLD}systemctl status demension${NC}"
echo -e "Сброс пароля:         ${BOLD}cd ${INSTALL_DIR} && PANEL_USER=admin PANEL_PASSWORD='...' node server/dist/cli/reset-admin.js${NC}"
echo -e "Директория:           ${BOLD}${INSTALL_DIR}${NC}"
echo -e "======================================================================"
echo -e "${YELLOW}Рекомендуется сразу включить HTTPS в разделе «Безопасность».${NC}"
