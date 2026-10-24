#!/bin/bash
# Прогон install.sh в чистом Ubuntu без systemd: подставные systemctl и docker, остальное — настоящее
# (apt, Node.js из NodeSource, npm ci, сборка, запуск службы по её unit-файлу).
set -uo pipefail

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
      (cd "$WD" && set -a && . "$ENVF" && set +a && umask 077 && nohup $EXEC >> /var/log/demension.log 2>&1 &)
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

cd /work

section "1. Занятый порт: установка должна остановиться ДО изменений"
(nc -l -p 3099 >/dev/null 2>&1 &)
sleep 1
PANEL_PORT=3099 bash install.sh > /tmp/busy.out 2>&1
CODE=$?
tail -5 /tmp/busy.out
[ "$CODE" -ne 0 ] || fail "установка при занятом порту завершилась успехом"
grep -q "уже занят" /tmp/busy.out || fail "нет сообщения о занятом порте"
[ ! -d /opt/demension-panel ] || fail "каталог установки создан, хотя порт занят"
pkill -f "nc -l -p 3099" || true

section "2. Первая установка без каких-либо переменных (порт по умолчанию 3001)"
bash install.sh > /tmp/install1.out 2>&1
CODE=$?
echo "exit code: $CODE"
sed 's/\x1b\[[0-9;]*m//g' /tmp/install1.out | tail -32
[ "$CODE" -eq 0 ] || fail "установка завершилась с ошибкой"

OUT=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/install1.out)
LOGIN=$(echo "$OUT" | sed -n 's/^Логин администратора: //p' | tail -1 | tr -d '[:space:]')
PASS=$(echo "$OUT" | sed -n 's/^Пароль администратора: //p' | tail -1 | tr -d '[:space:]')
URL=$(echo "$OUT" | sed -n 's/^Адрес панели: *//p' | tail -1 | tr -d '[:space:]')
echo "--- разобрано: login=[$LOGIN] password_len=${#PASS} url=[$URL]"
[[ "$LOGIN" =~ ^[a-z][a-z0-9]{9}$ ]] || fail "логин не случайный/неверного формата: $LOGIN"
[ "$LOGIN" != "admin" ] || fail "логин admin"
[[ "$PASS" =~ ^[A-Za-z0-9]{20}$ ]] || fail "пароль неверного формата"
[[ "$URL" =~ ^http://[0-9.]+:3001$ ]] || fail "адрес панели не похож на http://IP:3001: $URL"
echo "$OUT" | grep -q "amnezia-awg (amneziavpn" && echo "OK: список существующих контейнеров Amnezia показан" || fail "нет списка контейнеров Amnezia"

section "3. Вход с выданными логином и паролем (через адрес из вывода, с заменой IP на localhost)"
LOCAL_URL="http://127.0.0.1:3001"
STATUS=$(curl -s -o /tmp/login.json -w '%{http_code}' -X POST "$LOCAL_URL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$LOGIN\",\"password\":\"$PASS\"}")
echo "login status: $STATUS"
[ "$STATUS" = "200" ] || fail "выданные логин/пароль не подходят"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LOCAL_URL/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}')
[ "$STATUS" = "401" ] || fail "admin/admin не должен подходить, статус $STATUS"

section "3a. Версия панели: в выводе установщика и в API совпадает с package.json"
EXPECTED="v$(node -p "require('/work/package.json').version")"
SHOWN=$(echo "$OUT" | sed -n 's/^Версия панели: *//p' | tail -1 | tr -d '[:space:]')
echo "ожидается $EXPECTED, в выводе $SHOWN"
[ "$SHOWN" = "$EXPECTED" ] || fail "установщик показал версию «$SHOWN»"
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('/tmp/login.json','utf8')).token")
API_VERSION=$(curl -s "$LOCAL_URL/api/version" -H "Authorization: Bearer $TOKEN" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).current")
[ "$API_VERSION" = "$EXPECTED" ] || fail "API вернул версию «$API_VERSION»"

section "4. Безопасность установки"
stat -c '%a %U %n' /opt/demension-panel/server/.env /opt/demension-panel/data
grep -q "$PASS" /opt/demension-panel/server/.env && fail "пароль записан в .env"
grep -rq "$PASS" /opt/demension-panel/data 2>/dev/null && fail "пароль в открытом виде найден в data/"
grep -q "$PASS" /var/log/demension.log 2>/dev/null && fail "пароль попал в журнал службы"
cat /opt/demension-panel/server/.env
cat /etc/systemd/system/demension.service | sed -n 1,20p
grep -c "demension" /var/log/systemctl-shim.log | sed 's/^/вызовов systemctl: /'

section "5. Обновление поверх установленной панели: учётные данные не меняются"
bash install.sh > /tmp/install2.out 2>&1
CODE=$?
sed 's/\x1b\[[0-9;]*m//g' /tmp/install2.out | tail -14
[ "$CODE" -eq 0 ] || fail "обновление завершилось с ошибкой"
sed 's/\x1b\[[0-9;]*m//g' /tmp/install2.out | grep -q "не менялись" || fail "нет сообщения, что учётные данные не менялись"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LOCAL_URL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$LOGIN\",\"password\":\"$PASS\"}")
[ "$STATUS" = "200" ] || fail "после обновления прежние логин/пароль не работают"

section "6. Обновление с PANEL_RESET_CREDENTIALS=1: новые случайные данные"
PANEL_RESET_CREDENTIALS=1 bash install.sh > /tmp/install3.out 2>&1
OUT3=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/install3.out)
LOGIN3=$(echo "$OUT3" | sed -n 's/^Логин администратора: //p' | tail -1 | tr -d '[:space:]')
PASS3=$(echo "$OUT3" | sed -n 's/^Пароль администратора: //p' | tail -1 | tr -d '[:space:]')
echo "новый логин: $LOGIN3, длина пароля: ${#PASS3}"
[ "$LOGIN3" != "$LOGIN" ] || fail "логин не сменился"
[ "$PASS3" != "$PASS" ] || fail "пароль не сменился"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LOCAL_URL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$LOGIN3\",\"password\":\"$PASS3\"}")
[ "$STATUS" = "200" ] || fail "новые логин/пароль не подходят"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LOCAL_URL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$LOGIN\",\"password\":\"$PASS\"}")
[ "$STATUS" = "401" ] || fail "старые данные продолжают работать, статус $STATUS"

section "7. Свои значения через окружение: пароль не печатается"
PANEL_USER=my.login PANEL_PASSWORD='MyOwnPassword-123' bash install.sh > /tmp/install4.out 2>&1
OUT4=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/install4.out)
echo "$OUT4" | grep -E "^(Логин|Пароль)" || true
echo "$OUT4" | grep -q "MyOwnPassword-123" && fail "заданный пароль напечатан в консоль"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LOCAL_URL/api/auth/login" -H 'Content-Type: application/json' -d '{"username":"my.login","password":"MyOwnPassword-123"}')
[ "$STATUS" = "200" ] || fail "заданные логин/пароль не подходят"

section "8. CLI сброса пароля: без параметров выдаёт случайный пароль, логин сохраняется"
CLI=$(cd /opt/demension-panel && node server/dist/cli/reset-admin.js)
echo "$CLI"
NEWPASS=$(echo "$CLI" | sed -n 's/^Новый пароль: //p' | tr -d '[:space:]')
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LOCAL_URL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"my.login\",\"password\":\"$NEWPASS\"}")
[ "$STATUS" = "200" ] || fail "пароль из CLI не подходит (служба читает БД напрямую)"

section "9. Недопустимые данные"
PANEL_PASSWORD=short bash install.sh > /tmp/short.out 2>&1; [ $? -ne 0 ] && echo "OK: короткий пароль отклонён" || fail "короткий пароль принят"
PANEL_USER='bad user!' PANEL_PASSWORD='LongEnough-123' bash install.sh > /tmp/baduser.out 2>&1; [ $? -ne 0 ] && echo "OK: некорректный логин отклонён" || fail "некорректный логин принят"
PANEL_PORT=70000 bash install.sh > /tmp/badport.out 2>&1; [ $? -ne 0 ] && echo "OK: некорректный порт отклонён" || fail "некорректный порт принят"

section "10. Обновление сохраняет добавленные вручную переменные .env и убирает пароль старых версий"
ENVF=/opt/demension-panel/server/.env
printf 'TRUST_PROXY=loopback\n# комментарий администратора\nPANEL_USER=old\nPANEL_PASSWORD=OldPlainPassword-1\n' >> "$ENVF"
bash install.sh > /tmp/install5.out 2>&1 || fail "обновление с дополненным .env завершилось с ошибкой"
cat "$ENVF"
grep -qx 'TRUST_PROXY=loopback' "$ENVF" || fail "TRUST_PROXY потерян при обновлении"
grep -qx '# комментарий администратора' "$ENVF" || fail "комментарий в .env потерян"
grep -q 'PANEL_PASSWORD\|OldPlainPassword' "$ENVF" && fail "пароль старой версии остался в .env"
[ "$(grep -c '^PORT=' "$ENVF")" = 1 ] || fail "PORT в .env не единственный"
[ "$(stat -c '%a' "$ENVF")" = 600 ] || fail "права .env не 600"

section "11. Обновление из git: код скачивается, пока панель работает"
# /opt/demension-panel скопирован из /work и принадлежит не root: доверие к нему install.sh задаёт сам (safe.directory),
# тестовой обвязке — через G; удалённый репозиторий /tmp/origin создаётся root
git config --global user.email test@example.com && git config --global user.name test
G() { git -c safe.directory=/opt/demension-panel "$@"; }
rm -rf /tmp/origin && mkdir /tmp/origin && cp -r /work/. /tmp/origin/
git -C /tmp/origin init -q -b main && git -C /tmp/origin add -A && git -C /tmp/origin commit -qm base
G -C /opt/demension-panel init -q -b main
G -C /opt/demension-panel remote add origin /tmp/origin
G -C /opt/demension-panel fetch -q origin && G -C /opt/demension-panel reset -q origin/main
echo marker > /tmp/origin/UPDATE_MARKER && git -C /tmp/origin add -A && git -C /tmp/origin commit -qm update
bash install.sh > /tmp/install6.out 2>&1
CODE=$?
sed 's/\x1b\[[0-9;]*m//g' /tmp/install6.out | grep -E "Обновление|УСПЕХ|ERROR" || true
[ "$CODE" -eq 0 ] || fail "обновление из git завершилось с ошибкой"
[ -f /opt/demension-panel/UPDATE_MARKER ] || fail "git pull не выполнен"

section "12. Ошибка git pull: панель не останавливается"
G -C /opt/demension-panel remote set-url origin /nonexistent
: > /var/log/systemctl-shim.log
bash install.sh > /tmp/install7.out 2>&1
CODE=$?
sed 's/\x1b\[[0-9;]*m//g' /tmp/install7.out | tail -3
[ "$CODE" -ne 0 ] || fail "обновление без доступа к репозиторию завершилось успехом"
grep -q "продолжает работать" /tmp/install7.out || fail "нет сообщения, что панель продолжает работать"
grep -q "stop" /var/log/systemctl-shim.log && fail "служба остановлена, хотя обновление не скачалось"
curl -fsS --max-time 5 http://127.0.0.1:3001/api/health >/dev/null || fail "панель не отвечает после неудачного обновления"

echo
if [ "$FAILED" -eq 0 ]; then echo "=== ВСЕ ПРОВЕРКИ УСТАНОВКИ ПРОЙДЕНЫ ==="; else echo "=== ЕСТЬ ПРОВАЛЕННЫЕ ПРОВЕРКИ ==="; fi
exit "$FAILED"
