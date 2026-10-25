#!/bin/bash
# «Новый сервер» для проверки переноса панели: install.sh в режиме переноса забирает данные у прежней панели
# (контейнер mig-old, см. migration-old.sh). Переменные окружения от run.sh: MIGRATION_CODE, EXPECT_SECRET_KEY, EXPECT_SUB_TOKEN.
set -uo pipefail

source /harness/common.sh
cd /work

LOCAL=http://127.0.0.1:3001
ADMIN=old.admin
PASSWORD='OldAdminPass-123'
STRIP() { sed 's/\x1b\[[0-9;]*m//g'; }

section "M1. Неверный код: перенос отклонён, данные не созданы, на прежней панели ничего не меняется"
WRONG='AAAAA-BBBBB-CCCCC-DDDDD-EEEEE'
MIGRATE_FROM=http://mig-old:3001 MIGRATION_CODE="$WRONG" PANEL_CERT_MODE=none bash install.sh > /tmp/wrong.out 2>&1
CODE=$?
STRIP < /tmp/wrong.out | tail -6
[ "$CODE" -ne 0 ] || fail "перенос с неверным кодом завершился успехом"
STRIP < /tmp/wrong.out | grep -q "Неверный или просроченный код" || fail "нет сообщения о неверном коде"
[ ! -f /opt/demension-panel/data/demension.db ] || fail "база создана, хотя код неверный"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://mig-old:3001/api/health)" = 200 ] || fail "прежняя панель не отвечает"

section "M2. Перенос: все данные переезжают, логин и пароль прежние, сертификат — без HTTPS (PANEL_CERT_MODE=none)"
MIGRATE_FROM=http://mig-old:3001 PANEL_CERT_MODE=none bash install.sh > /tmp/migrate.out 2>&1
CODE=$?
STRIP < /tmp/migrate.out | tail -32
[ "$CODE" -eq 0 ] || fail "перенос завершился с ошибкой"
OUT=$(STRIP < /tmp/migrate.out)
echo "$OUT" | grep -q "панель перенесена на этот сервер" || fail "нет сообщения об успешном переносе"
echo "$OUT" | grep -q "Логин администратора: ${ADMIN}" || fail "установщик не показал прежний логин"
echo "$OUT" | grep -q "Пароль администратора: прежний" || fail "установщик не сообщил, что пароль прежний"
echo "$OUT" | grep -q "Прежняя панель заморожена" || fail "прежняя панель не заморожена"
echo "$OUT" | grep -E '^Адрес панели:' | grep -qE 'http://[0-9.]+:3001' || fail "адрес новой панели не показан: $(echo "$OUT" | grep '^Адрес панели')"

STATUS=$(curl -s -o /tmp/login.json -w '%{http_code}' -X POST "$LOCAL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\"}")
[ "$STATUS" = 200 ] || fail "прежние логин и пароль не подходят на новой панели ($STATUS)"
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('/tmp/login.json','utf8')).token")
SERVERS=$(curl -s "$LOCAL/api/servers" -H "Authorization: Bearer $TOKEN")
echo "$SERVERS" | grep -q '"Seed Node"' || fail "нода не перенесена: $SERVERS"
echo "$SERVERS" | grep -q '"has_ssh_password":true' || fail "SSH-доступ ноды потерян"
echo "$SERVERS" | grep -q 'seed-ssh-password' && fail "SSH-пароль утёк в ответ API"
SUBS=$(curl -s "$LOCAL/api/subscribers" -H "Authorization: Bearer $TOKEN")
echo "$SUBS" | grep -q '"seed-user"' || fail "пользователь не перенесён"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL/sub/$EXPECT_SUB_TOKEN")" = 200 ] || fail "ссылка подписки не работает на новой панели"
PUBLIC_URL=$(curl -s "$LOCAL/api/settings" -H "Authorization: Bearer $TOKEN" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).public_url")
echo "публичный адрес после переноса: $PUBLIC_URL"
[[ "$PUBLIC_URL" =~ ^http://[0-9.]+:3001$ ]] || fail "публичный адрес не обновлён на адрес новой панели: $PUBLIC_URL"

section "M3. Ключ шифрования переехал, код переноса нигде не остался, права файлов"
[ "$(cat /opt/demension-panel/data/secret.key)" = "$EXPECT_SECRET_KEY" ] || fail "ключ шифрования отличается от прежнего"
ENVF=/opt/demension-panel/server/.env
cat "$ENVF"
grep -q DEMENSION_SECRET_KEY "$ENVF" && fail "ключ шифрования записан в .env"
[ "$(stat -c '%a' "$ENVF")" = 600 ] || fail "права .env не 600"
[ "$(stat -c '%a' /opt/demension-panel/data/secret.key)" = 600 ] || fail "права secret.key не 600"
BARE=$(echo "$MIGRATION_CODE" | tr -d '-')
grep -rqE "$MIGRATION_CODE|$BARE" /opt/demension-panel/data /opt/demension-panel/server/.env /var/log/demension.log 2>/dev/null && fail "код переноса остался в данных или журнале"
grep -q "$MIGRATION_CODE" /tmp/migrate.out && fail "код переноса напечатан в консоль"
LEFT=$(cd /opt/demension-panel && node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('data/demension.db', { readOnly: true }); console.log(db.prepare(\"SELECT COUNT(*) AS c FROM settings WHERE substr(key, 1, 9) = 'migration'\").get().c)")
[ "$LEFT" = 0 ] || fail "служебные настройки переноса остались в БД ($LEFT)"

section "M4. Обновление перенесённой панели с включённым HTTPS: проверка запуска работает по HTTP"
(cd /opt/demension-panel && node server/dist/cli/migration.js ssl --mode ip --ip 127.0.0.1) > /tmp/ssl-ip.out 2>&1
cat /tmp/ssl-ip.out | grep -v '^@@'
systemctl restart demension.service
sleep 4
HEALTH=$(curl -s "$LOCAL/api/health")
echo "health по HTTP при включённом HTTPS: $HEALTH"
echo "$HEALTH" | grep -q '"https":true' || fail "HTTPS не включился"
bash install.sh > /tmp/update-https.out 2>&1
CODE=$?
STRIP < /tmp/update-https.out | tail -8
[ "$CODE" -eq 0 ] || fail "обновление панели с включённым HTTPS завершилось ошибкой (проверка запуска по HTTP)"

echo
if [ "$FAILED" -eq 0 ]; then echo "=== ПЕРЕНОС ПАНЕЛИ: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ==="; else echo "=== ПЕРЕНОС ПАНЕЛИ: ЕСТЬ ПРОВАЛЕННЫЕ ПРОВЕРКИ ==="; fi
exit "$FAILED"
