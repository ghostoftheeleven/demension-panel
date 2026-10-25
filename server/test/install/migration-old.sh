#!/bin/bash
# «Прежний сервер» для проверки переноса панели: обычная установка, данные для переноса, код переноса; затем контейнер
# остаётся жить (run.sh запускает на втором контейнере migration-new.sh и после него проверяет состояние этой панели).
set -uo pipefail

source /harness/common.sh
cd /work

PASSWORD='OldAdminPass-123'
LOCAL=http://127.0.0.1:3001

PANEL_USER=old.admin PANEL_PASSWORD="$PASSWORD" bash install.sh > /tmp/old-install.out 2>&1 || {
  tail -40 /tmp/old-install.out
  echo "ТЕСТ ПРОВАЛЕН: установка прежней панели"
  exit 1
}

TOKEN=$(curl -s -X POST "$LOCAL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"old.admin\",\"password\":\"$PASSWORD\"}" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
api() { curl -s -X "$1" "$LOCAL$2" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${3:+-d "$3"}; }

# Данные, которые должны переехать: нода (с SSH-паролем, зашифрованным ключом панели), пользователь с подпиской, публичный адрес
api POST /api/servers '{"name":"Seed Node","host":"203.0.113.50","ssh_user":"root","ssh_password":"seed-ssh-password"}' > /tmp/seed-server.json
node -e "const s=JSON.parse(require('fs').readFileSync('/tmp/seed-server.json','utf8')); if(!s.id) { console.error('сервер не создан', s); process.exit(1); }"
api POST /api/subscribers '{"name":"seed-user","server_ids":[]}' > /tmp/seed-sub.json
node -p "JSON.parse(require('fs').readFileSync('/tmp/seed-sub.json','utf8')).token" > /tmp/sub-token
api PUT /api/settings '{"public_url":"http://mig-old:3001"}' > /dev/null

PREPARED=$(api POST /api/migration/prepare "{\"password\":\"$PASSWORD\"}")
node -p "JSON.parse(process.argv[1]).code" "$PREPARED" > /tmp/migration-code
[ -s /tmp/migration-code ] || { echo "ТЕСТ ПРОВАЛЕН: код переноса не выдан: $PREPARED"; exit 1; }
cat /opt/demension-panel/data/secret.key > /tmp/old-secret-key

touch /tmp/old-ready
echo "прежняя панель готова к переносу"
sleep 3600
