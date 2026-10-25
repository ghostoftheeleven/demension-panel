#!/bin/bash
# «Новый сервер» для проверки переноса панели: install.sh забирает данные у прежней панели (контейнер mig-old, см.
# migration-old.sh). Переменные окружения от run.sh: MIGRATION_CODE, MIGRATION_AUTH, EXPECT_SECRET_KEY, EXPECT_SUB_TOKEN.
#
#   S1  интерактивный перенос из файла в псевдотерминале (вопросы, скрытый ввод кода, сертификат на IP) — прежняя панель не трогается
#   S2  неверный код и отказ заменить данные: ничего не меняется
#   S3  перенос по сети с заменой (MIGRATE_REPLACE=1): данные, логин и пароль, ключ шифрования, заморозка прежней панели
#   S4  обновление перенесённой панели с включённым HTTPS
set -uo pipefail

source /harness/common.sh
cd /work
apt-get install -y -qq curl python3 >/dev/null 2>&1

LOCAL=http://127.0.0.1:3001
ADMIN=old.admin
PASSWORD='OldAdminPass-123'
INSTALL=/opt/dementia-panel
STRIP() { sed 's/\x1b\[[0-9;]*m//g'; }
login_status() { curl -s -o /tmp/login.json -w '%{http_code}' -X POST "$1/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\"}"; }

section "S0. Архив переноса файлом (так делает кнопка «Скачать архив файлом»)"
curl -fsS -H "X-Migration-Auth: $MIGRATION_AUTH" http://mig-old:3001/api/migration/archive -o /root/migration.dpm || fail "архив не получен"
[ "$(head -c 8 /root/migration.dpm)" = "DMPANEL1" ] || fail "файл не похож на архив переноса"
grep -q "seed-ssh-password" /root/migration.dpm && fail "SSH-пароль виден в архиве открытым текстом"
ls -l /root/migration.dpm

section "S1. Интерактивный перенос из файла в терминале: режим, источник, код, порт, сертификат на IP"
# Node.js на новом сервере ещё нет (его ставит install.sh): ответы — JSON-литерал; {{CODE}} подставляет pty-drive.py из PTY_CODE
ANSWERS='[
  ["Выбор \\[1\\]: ", "2"],
  ["Адрес прежней панели .*архива: ", "/root/migration.dpm"],
  ["Код переноса .*: ", "{{CODE}}"],
  ["Порт панели \\[3001\\]: ", ""],
  ["Выбор \\[1\\]: ", "3"],
  ["Использовать сертификат на IP-адрес\\? \\[y/N\\]: ", "y"],
  ["IP-адрес сервера для сертификата \\[.*\\]: ", ""],
  ["Enter — пропустить\\): ", ""]
]'
# Код не передаётся в окружении: его нужно ввести (скрыто) в терминале
PTY_CODE="$MIGRATION_CODE" env -u MIGRATION_CODE python3 /harness/pty-drive.py /tmp/interactive.log "$ANSWERS" -- bash install.sh
CODE=$?
STRIP < /tmp/interactive.log | tr -d '\r' | grep -vE "^(npm|added|found|up to)" | tail -45
[ "$CODE" -eq 0 ] || fail "интерактивный перенос завершился с ошибкой ($CODE)"
OUT=$(STRIP < /tmp/interactive.log | tr -d '\r')
echo "$OUT" | grep -q "Что нужно сделать?" || fail "не показан вопрос о режиме"
echo "$OUT" | grep -q "Как получить сертификат для панели?" || fail "не показано меню сертификата"
echo "$OUT" | grep -q "ПОДПИСКИ ПО https:// РАБОТАТЬ НЕ БУДУТ" || fail "нет предупреждения, что подписки с сертификатом на IP работать не будут"
echo "$OUT" | grep -q "панель перенесена на этот сервер" || fail "нет сообщения об успешном переносе"
echo "$OUT" | grep -q "Прежняя панель ещё не отключена" || fail "установщик не напомнил, что прежняя панель не отключена (перенос из файла)"
grep -q "$MIGRATION_CODE" /tmp/interactive.log && fail "код переноса виден в журнале терминала (ввод должен быть скрыт)"
echo "$OUT" | grep -E '^Адрес панели:' | grep -qE 'http://[0-9.]+:3001' && fail "после выбора HTTPS адрес панели остался http://"
echo "$OUT" | grep -E '^Адрес панели:' | grep -qE 'https://[0-9.]+:3001' || fail "адрес панели не https://IP:3001: $(echo "$OUT" | grep '^Адрес панели')"
HEALTH=$(curl -s "$LOCAL/api/health")
echo "health по HTTP: $HEALTH"
echo "$HEALTH" | grep -q '"https":true' || fail "HTTPS не включён"
STATUS=$(curl -sk -o /tmp/login.json -w '%{http_code}' -X POST https://127.0.0.1:3001/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\"}")
[ "$STATUS" = 200 ] || fail "прежние логин и пароль не подходят по HTTPS ($STATUS)"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL/sub/$EXPECT_SUB_TOKEN")" = 200 ] || fail "подписка по HTTP не работает при включённом HTTPS"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://mig-old:3001/api/health)" = 200 ] || fail "прежняя панель не отвечает"
OLD_STATE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://mig-old:3001/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN\",\"password\":\"$PASSWORD\"}")
[ "$OLD_STATE" = 200 ] || fail "прежняя панель не должна замораживаться при переносе из файла без её адреса (статус $OLD_STATE)"
SECRET_HASH=$(sha256sum $INSTALL/data/secret.key | cut -d' ' -f1)

section "S2. Неверный код и отказ заменить данные: данные установленной панели не меняются"
MIGRATE_FROM=http://mig-old:3001 MIGRATION_CODE='AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' PANEL_CERT_MODE=none bash install.sh > /tmp/wrong.out 2>&1
CODE=$?
STRIP < /tmp/wrong.out | tail -6
[ "$CODE" -ne 0 ] || fail "перенос с неверным кодом завершился успехом"
STRIP < /tmp/wrong.out | grep -q "Неверный или просроченный код" || fail "нет сообщения о неверном коде"
[ "$(sha256sum $INSTALL/data/secret.key | cut -d' ' -f1)" = "$SECRET_HASH" ] || fail "данные изменились после неверного кода"
ls $INSTALL/data/dementia.db > /dev/null || fail "база пропала после неверного кода"

MIGRATE_FROM=http://mig-old:3001 PANEL_CERT_MODE=none bash install.sh > /tmp/refused.out 2>&1
CODE=$?
STRIP < /tmp/refused.out | tail -6
[ "$CODE" -ne 0 ] || fail "перенос поверх панели с данными без подтверждения завершился успехом"
STRIP < /tmp/refused.out | grep -q "Перенос отменён" || fail "нет сообщения об отмене переноса"
STRIP < /tmp/refused.out | grep -q "systemctl start dementia" || fail "нет подсказки, как запустить остановленную панель"
[ "$(sha256sum $INSTALL/data/secret.key | cut -d' ' -f1)" = "$SECRET_HASH" ] || fail "данные изменились без подтверждения замены"
ls -d $INSTALL/data/backups/pre-migration-* > /dev/null 2>&1 && fail "копия «до замены» создана, хотя замена не подтверждена"
systemctl start dementia.service
sleep 4

section "S3. Перенос по сети с заменой данных: данные, логин и пароль, ключ шифрования, заморозка прежней панели"
MIGRATE_FROM=http://mig-old:3001 MIGRATE_REPLACE=1 PANEL_CERT_MODE=none bash install.sh > /tmp/migrate.out 2>&1
CODE=$?
STRIP < /tmp/migrate.out | tail -32
[ "$CODE" -eq 0 ] || fail "перенос завершился с ошибкой"
OUT=$(STRIP < /tmp/migrate.out)
echo "$OUT" | grep -q "панель перенесена на этот сервер" || fail "нет сообщения об успешном переносе"
echo "$OUT" | grep -q "Логин администратора: ${ADMIN}" || fail "установщик не показал прежний логин"
echo "$OUT" | grep -q "Пароль администратора: прежний" || fail "установщик не сообщил, что пароль прежний"
echo "$OUT" | grep -q "Прежняя панель заморожена" || fail "прежняя панель не заморожена"
echo "$OUT" | grep -E '^Адрес панели:' | grep -qE 'http://[0-9.]+:3001' || fail "адрес новой панели не показан: $(echo "$OUT" | grep '^Адрес панели')"
ls -d $INSTALL/data/backups/pre-migration-* > /dev/null 2>&1 || fail "копия прежних данных перед заменой не создана"
curl -s "$LOCAL/api/health" | grep -q '"https":false' || fail "HTTPS должен быть выключен выбором PANEL_CERT_MODE=none"

[ "$(login_status $LOCAL)" = 200 ] || fail "прежние логин и пароль не подходят на новой панели"
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('/tmp/login.json','utf8')).token")
SERVERS=$(curl -s "$LOCAL/api/servers" -H "Authorization: Bearer $TOKEN")
echo "$SERVERS" | grep -q '"Seed Node"' || fail "нода не перенесена: $SERVERS"
echo "$SERVERS" | grep -q '"has_ssh_password":true' || fail "SSH-доступ ноды потерян"
echo "$SERVERS" | grep -q 'seed-ssh-password' && fail "SSH-пароль утёк в ответ API"
curl -s "$LOCAL/api/subscribers" -H "Authorization: Bearer $TOKEN" | grep -q '"seed-user"' || fail "пользователь не перенесён"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$LOCAL/sub/$EXPECT_SUB_TOKEN")" = 200 ] || fail "ссылка подписки не работает на новой панели"
PUBLIC_URL=$(curl -s "$LOCAL/api/settings" -H "Authorization: Bearer $TOKEN" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).public_url")
echo "публичный адрес после переноса: $PUBLIC_URL"
[[ "$PUBLIC_URL" =~ ^http://[0-9.]+:3001$ ]] || fail "публичный адрес не обновлён на адрес новой панели: $PUBLIC_URL"

section "S3b. Ключ шифрования переехал, код переноса нигде не остался, права файлов"
[ "$(cat $INSTALL/data/secret.key)" = "$EXPECT_SECRET_KEY" ] || fail "ключ шифрования отличается от прежнего"
ENVF=$INSTALL/server/.env
cat "$ENVF"
grep -q DEMENTIA_SECRET_KEY "$ENVF" && fail "ключ шифрования записан в .env"
[ "$(stat -c '%a' "$ENVF")" = 600 ] || fail "права .env не 600"
[ "$(stat -c '%a' $INSTALL/data/secret.key)" = 600 ] || fail "права secret.key не 600"
BARE=$(echo "$MIGRATION_CODE" | tr -d '-')
grep -rqE "$MIGRATION_CODE|$BARE" $INSTALL/data $INSTALL/server/.env /var/log/dementia.log 2>/dev/null && fail "код переноса остался в данных или журнале"
grep -q "$MIGRATION_CODE" /tmp/migrate.out && fail "код переноса напечатан в консоль"
LEFT=$(cd $INSTALL && node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('data/dementia.db', { readOnly: true }); console.log(db.prepare(\"SELECT COUNT(*) AS c FROM settings WHERE substr(key, 1, 9) = 'migration'\").get().c)")
[ "$LEFT" = 0 ] || fail "служебные настройки переноса остались в БД ($LEFT)"

section "S4. Обновление перенесённой панели с включённым HTTPS: проверка запуска работает по HTTP"
(cd $INSTALL && node server/dist/cli/migration.js ssl --mode ip --ip 127.0.0.1) > /tmp/ssl-ip.out 2>&1
grep -v '^@@' /tmp/ssl-ip.out
systemctl restart dementia.service
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
