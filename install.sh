#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Demension Panel - Automated Server Deployment Script
#
# Интерактивно:      curl -sSL .../install.sh | sudo bash
# Без вопросов:      curl -sSL .../install.sh | sudo PANEL_PORT=3001 bash
#
# Логин и пароль администратора при первой установке генерируются случайно и показываются в конце установки
# ОДИН РАЗ (в БД хранится только хэш). Свои значения можно передать через PANEL_USER / PANEL_PASSWORD.
# При обновлении существующей панели учётные данные не меняются; PANEL_RESET_CREDENTIALS=1 выдаёт новые случайные.
# Установка не трогает Docker и контейнеры на сервере (в том числе AmneziaWG приложения Amnezia).
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

# При запуске через `curl | bash` stdin занят самим скриптом — вопросы задаём через терминал.
# Узел /dev/tty есть и без терминала (ssh без -t, cron, CI, docker без -t), но открыть его нельзя — поэтому проверяется открытие.
if (exec < /dev/tty) 2>/dev/null && (exec > /dev/tty) 2>/dev/null; then
  TTY=/dev/tty
else
  TTY=""
fi

ask() { # ask VAR "Вопрос" "по умолчанию"
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=""
  if [ -n "${!__var:-}" ]; then return; fi
  if [ -n "$TTY" ]; then
    read -r -p "$__prompt" __reply < "$TTY" || __reply=""
  fi
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

CREDS_PENDING=false
print_pending_credentials() { # при обрыве установки после создания администратора пароль всё равно показывается
  if [ "$CREDS_PENDING" = true ]; then
    echo -e "\n${YELLOW}Установка прервана, но учётные данные администратора уже созданы:${NC}"
    echo "  Логин:  $PANEL_USER"
    if [ -n "${GENERATED_PASSWORD_VALUE:-}" ]; then echo "  Пароль: $GENERATED_PASSWORD_VALUE"; fi
    echo "  Новый пароль при необходимости: cd ${INSTALL_DIR} && node server/dist/cli/reset-admin.js"
  fi
}
trap print_pending_credentials EXIT

rand_chars() { # rand_chars ДЛИНА НАБОР — случайная строка из /dev/urandom
  local out=""
  while [ "${#out}" -lt "$1" ]; do
    out+=$(head -c 96 /dev/urandom | LC_ALL=C tr -dc "$2" || true)
  done
  printf '%s' "${out:0:$1}"
}

port_listeners() { # port_listeners ПОРТ — строки процессов, слушающих TCP-порт (пусто, если порт свободен)
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null || true
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v port=":$1" '$4 ~ port"$"' || true
  fi
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

# Контейнеры AmneziaWG, уже работающие на сервере (например, от приложения AmneziaVPN): установка панели их не трогает
EXISTING_AWG=""
if command -v docker >/dev/null 2>&1; then
  EXISTING_AWG="$(docker ps -a --format '{{.Names}} ({{.Image}})' 2>/dev/null | grep -i 'amnezia' || true)"
fi

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

# Учётные данные администратора: при первой установке — случайные; при обновлении остаются прежними
SET_CREDENTIALS=true
if [ "$UPDATE" = true ] && [ -z "${PANEL_PASSWORD:-}" ] && [ -z "${PANEL_USER:-}" ] && [ "${PANEL_RESET_CREDENTIALS:-}" != "1" ]; then
  CHANGE_CREDS=""
  ask CHANGE_CREDS "Обнаружена установленная панель. Выдать новые случайные логин и пароль администратора? [y/N]: " "n"
  case "$CHANGE_CREDS" in
    y|Y|yes|д|Д) ;;
    *) SET_CREDENTIALS=false ;;
  esac
fi

GENERATED_PASSWORD=false
if [ "$SET_CREDENTIALS" = true ]; then
  if [ -z "${PANEL_USER:-}" ]; then
    # Логин начинается с буквы: так он однозначно читается и вводится
    PANEL_USER="$(rand_chars 1 'a-z')$(rand_chars 9 'a-z0-9')"
  elif ! [[ "$PANEL_USER" =~ ^[A-Za-z0-9._@-]{1,64}$ ]]; then
    echo -e "${RED}[ERROR] Логин администратора: до 64 символов из A-Z a-z 0-9 . _ @ -${NC}"
    exit 1
  fi
  if [ -z "${PANEL_PASSWORD:-}" ]; then
    PANEL_PASSWORD="$(rand_chars 20 'A-Za-z0-9')"
    GENERATED_PASSWORD=true
  elif [ ${#PANEL_PASSWORD} -lt 8 ]; then
    echo -e "${RED}[ERROR] Пароль должен содержать не менее 8 символов.${NC}"
    exit 1
  fi
fi

# Порт панели должен быть свободен (кроме случая, когда его уже занимает сама обновляемая панель)
if [ -n "$(port_listeners "$PANEL_PORT")" ]; then
  if [ "$UPDATE" = true ] && [ "$PANEL_PORT" = "${CURRENT_PORT:-3001}" ] && systemctl is-active --quiet demension.service 2>/dev/null; then
    :
  else
    echo -e "${RED}[ERROR] TCP-порт ${PANEL_PORT} уже занят:${NC}"
    port_listeners "$PANEL_PORT"
    echo -e "Выберите другой порт: PANEL_PORT=<порт> (или освободите этот)."
    exit 1
  fi
fi

# 4. Clone or Update Repository
echo -e "\n${CYAN}[3/7] Развертывание кодовой базы в ${INSTALL_DIR}...${NC}"
# Новый код скачивается, пока панель ещё работает: при ошибке (нет сети, локальные правки) она остаётся запущенной
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Обновление существующей установки..."
  if ! git -C "$INSTALL_DIR" pull --ff-only origin main; then
    echo -e "${RED}[ERROR] Не удалось получить обновление (git pull). Панель продолжает работать на прежней версии.${NC}"
    echo -e "Проверьте доступ к GitHub и локальные изменения: git -C ${INSTALL_DIR} status"
    exit 1
  fi
fi

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
  : # уже обновлено выше
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

# Пароль в .env не хранится: учётные данные записываются сразу в БД (только хэш).
# Добавленные вручную переменные (DEMENSION_SECRET_KEY, TRUST_PROXY и т.п.) сохраняются: без DEMENSION_SECRET_KEY панель
# не расшифровала бы SSH-доступы к нодам. PANEL_USER/PANEL_PASSWORD от старых версий установщика удаляются.
umask 077
ENV_FILE="$INSTALL_DIR/server/.env"
KEPT_ENV=""
if [ -f "$ENV_FILE" ]; then
  KEPT_ENV="$(grep -Ev '^[[:space:]]*(export[[:space:]]+)?(PORT|NODE_ENV|PANEL_USER|PANEL_PASSWORD)[[:space:]]*=' "$ENV_FILE" || true)"
fi
{
  echo "PORT=${PANEL_PORT}"
  echo "NODE_ENV=production"
  if [ -n "$KEPT_ENV" ]; then printf '%s\n' "$KEPT_ENV"; fi
} > "$ENV_FILE.new"
chmod 600 "$ENV_FILE.new"
mv -f "$ENV_FILE.new" "$ENV_FILE"
unset KEPT_ENV

if [ "$SET_CREDENTIALS" = true ]; then
  PANEL_USER="$PANEL_USER" PANEL_PASSWORD="$PANEL_PASSWORD" node "$INSTALL_DIR/server/dist/cli/reset-admin.js"
fi
GENERATED_PASSWORD_VALUE=""
if [ "$GENERATED_PASSWORD" = true ]; then GENERATED_PASSWORD_VALUE="$PANEL_PASSWORD"; fi
if [ "$SET_CREDENTIALS" = true ]; then CREDS_PENDING=true; fi
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

# 8. Fail2ban SSH Protection — необязательный шаг: его сбой не должен обрывать установку уже работающей панели
setup_fail2ban() {
  local HAD_FAIL2BAN=false SSH_PORT BACKEND
  echo -e "\n${CYAN}[7/7] Настройка защиты SSH от перебора (Fail2ban)...${NC}"
  if command -v fail2ban-client >/dev/null 2>&1; then
    HAD_FAIL2BAN=true
  else
    if [ "$PM" = apt ]; then
      apt-get install -y fail2ban || true
    else
      dnf install -y epel-release || true
      dnf install -y fail2ban || true
    fi
  fi

  if [ "$HAD_FAIL2BAN" = true ]; then
    echo "Fail2ban уже установлен на сервере — его настройки не менялись (защиту sshd можно включить в разделе «Безопасность» панели)."
  elif command -v fail2ban-client >/dev/null 2>&1; then
  SSH_PORT=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)
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
}
setup_fail2ban || echo -e "${YELLOW}Не удалось настроить fail2ban — это не мешает работе панели (настройка есть в разделе «Безопасность»).${NC}"

# Панель должна ответить, прежде чем объявлять об успехе
echo -e "\n${CYAN}Проверка запуска панели...${NC}"
PANEL_UP=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PANEL_PORT}/api/health" >/dev/null 2>&1; then
    PANEL_UP=true
    break
  fi
  sleep 1
done
if [ "$PANEL_UP" != true ]; then
  echo -e "${RED}[ERROR] Панель не отвечает на порту ${PANEL_PORT}. Последние строки журнала:${NC}"
  journalctl -u demension.service -n 40 --no-pager 2>/dev/null || true
  echo -e "Повторить запуск: systemctl restart demension; журнал: journalctl -u demension -f"
  exit 1
fi
echo -e "${GREEN}✓ Панель запущена.${NC}"

# Адрес для браузера: внешний IPv4 сервера; если определить не удалось — первый адрес интерфейсов
SERVER_IP=""
for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
  CANDIDATE="$(curl -s -4 --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$CANDIDATE" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    SERVER_IP="$CANDIDATE"
    break
  fi
done
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
SERVER_IP="${SERVER_IP:-IP_СЕРВЕРА}"

echo -e "\n${GREEN}${BOLD}======================================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 УСПЕХ: Demension Panel установлена и запущена!${NC}"
echo -e "${GREEN}${BOLD}======================================================================${NC}"
echo -e "Адрес панели:         ${BOLD}${CYAN}http://${SERVER_IP}:${PANEL_PORT}${NC}"
if [ "$SET_CREDENTIALS" = true ]; then
  echo -e "Логин администратора: ${BOLD}${PANEL_USER}${NC}"
  if [ "$GENERATED_PASSWORD" = true ]; then
    echo -e "Пароль администратора: ${BOLD}${GENERATED_PASSWORD_VALUE}${NC}"
    echo -e "${YELLOW}Сохраните логин и пароль сейчас: пароль нигде не хранится и больше показан не будет.${NC}"
  else
    echo -e "Пароль администратора: заданный вами (PANEL_PASSWORD)"
  fi
else
  echo -e "Логин и пароль:       не менялись (прежние)"
fi
echo -e "Служба systemd:       ${BOLD}systemctl status demension${NC}"
echo -e "Новый пароль:         ${BOLD}cd ${INSTALL_DIR} && node server/dist/cli/reset-admin.js${NC}  (выдаст случайный)"
echo -e "Директория:           ${BOLD}${INSTALL_DIR}${NC} (данные и ключ шифрования — ${INSTALL_DIR}/data, делайте его резервную копию)"
echo -e "======================================================================"
CREDS_PENDING=false
if [ -n "$EXISTING_AWG" ]; then
  echo -e "${YELLOW}На сервере уже есть контейнеры AmneziaWG — панель их не трогала:${NC}"
  echo "$EXISTING_AWG" | sed 's/^/  • /'
  echo -e "Чтобы управлять ими из панели: «Добавить сервер» (адрес этого сервера и SSH-доступ) — панель найдёт контейнер и"
  echo -e "подключит его вместе с клиентами. Не нажимайте «Установить», пока не подключите существующий контейнер."
fi
echo -e "${YELLOW}Первый вход по http:// передаёт пароль открытым текстом: сразу включите HTTPS в разделе «Безопасность»${NC}"
echo -e "${YELLOW}или откройте панель через SSH-туннель: ssh -L ${PANEL_PORT}:127.0.0.1:${PANEL_PORT} root@${SERVER_IP}  →  http://127.0.0.1:${PANEL_PORT}${NC}"
