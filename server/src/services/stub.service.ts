import crypto from 'node:crypto';

/**
 * Заглушка для проверки доступности ноды (docs/probes.md). На ноде работает отдельный контейнер dementia-probe: на случайном
 * свободном порту он отдаёт нейтральную веб-страницу по TCP и отвечает на любой UDP-пакет, записывая в журнал время, адрес
 * отправителя и путь запроса. Проверяющие узлы check-host.net обращаются к заглушке, а панель по журналу на самой ноде
 * убеждается, что запросы действительно дошли: ответ, подделанный провайдером по дороге, в журнал не попадает.
 *
 * Контейнер AmneziaWG заглушка не трогает: у неё свой контейнер, свой каталог и сеть хоста.
 */

export const STUB_CONTAINER = 'dementia-probe';
export const STUB_DIR = '/opt/dementia-probe';
/** Образ с пакетным менеджером: socat ставится при первом запуске контейнера */
export const STUB_IMAGE = 'alpine:3.20';

const PORT_MIN = 20000;
const PORT_MAX = 60999;
/** Порты из диапазона, которые часто заняты или выделяются сканерами (игровые серверы, медиасерверы, VPN по умолчанию) */
const COMMON_PORTS = new Set([
  25565, 27015, 27016, 27017, 28015, 30000, 30120, 32400, 33848, 34197, 37777, 40000, 41641, 44158, 45876, 49152, 50000, 50051,
  51413, 51820, 51821, 52000, 54321, 55000, 55555, 60000,
]);

export interface StubHit {
  /** Время обращения, секунды Unix */
  at: number;
  proto: 'tcp' | 'udp';
  ip: string;
  /** Путь HTTP-запроса (для UDP — пусто) */
  path: string;
}

/** Случайные кандидаты в порт заглушки: текущий порт (если есть) первым, затем случайные из 20000–60999 */
export function stubPortCandidates(exclude: number[], current: number | null = null, count = 8): number[] {
  const skip = new Set(exclude);
  const result: number[] = current && !skip.has(current) ? [current] : [];
  while (result.length < count) {
    const port = PORT_MIN + crypto.randomInt(PORT_MAX - PORT_MIN + 1);
    if (!COMMON_PORTS.has(port) && !skip.has(port) && !result.includes(port)) result.push(port);
  }
  return result;
}

export function newStubToken(): string {
  return crypto.randomBytes(12).toString('hex');
}

/** Страница-заглушка: обычный сайт «в разработке»; метка в комментарии подтверждает, что ответила именно заглушка */
export function stubPage(token: string): string {
  return (
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Coming soon</title><style>body{font-family:sans-serif;max-width:40rem;margin:5rem auto;padding:0 1rem;color:#333}</style></head>' +
    '<body><h1>Coming soon</h1><p>This site is under construction. Please check back later.</p>' +
    `<!-- ${token} --></body></html>\n`
  );
}

/** Обработчик одного обращения (запускается socat на каждое подключение или UDP-пакет) */
const HANDLER = `#!/bin/sh
f=/data/hits.log
if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 1048576 ]; then tail -n 2000 "$f" > "$f.tmp" && mv -f "$f.tmp" "$f"; fi
peer=$(printf '%s' "\${SOCAT_PEERADDR:-}" | tr -cd '0-9a-fA-F.:' | cut -c1-45)
now=$(date +%s)
if [ "$1" = udp ]; then
  dd bs=2048 count=1 >/dev/null 2>&1
  echo "$now udp \${peer:--} -" >> "$f"
  printf 'ok\\n'
  exit 0
fi
IFS= read -r line || line=
path=$(printf '%s' "$line" | awk '{print $2}' | tr -cd 'A-Za-z0-9/_-' | cut -c1-80)
cr=$(printf '\\r')
while IFS= read -r h; do
  if [ -z "$h" ] || [ "$h" = "$cr" ]; then break; fi
done
echo "$now tcp \${peer:--} \${path:--}" >> "$f"
len=$(wc -c < /data/page.html)
printf 'HTTP/1.1 200 OK\\r\\nServer: nginx\\r\\nContent-Type: text/html; charset=utf-8\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n' "$len"
cat /data/page.html
`;

/** Точка входа контейнера: TCP и UDP на одном номере порта, упавший socat перезапускается */
const RUNNER = `#!/bin/sh
command -v socat >/dev/null 2>&1 || apk add --no-cache socat >/dev/null 2>&1 || { echo 'socat не установлен'; sleep 30; exit 1; }
P=$(cat /data/port)
( while true; do socat -T5 TCP4-LISTEN:"$P",fork,reuseaddr EXEC:"/data/handler.sh tcp"; sleep 1; done ) &
while true; do socat -T2 UDP4-RECVFROM:"$P",fork EXEC:"/data/handler.sh udp"; sleep 1; done
`;

/**
 * Скрипт установки (POSIX sh, выполняется от root). Пересоздаёт контейнер заглушки на первом свободном порту из кандидатов
 * и печатает `---STUB_PORT <порт>`. Кандидаты — числа, страница и метка передаются в base64: подстановки в shell нет.
 */
export function stubInstallScript(candidates: number[], token: string): string {
  const ports = candidates.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535).join(' ');
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  return [
    'set -eu',
    `D=${STUB_DIR}`,
    `C=${STUB_CONTAINER}`,
    "command -v docker >/dev/null 2>&1 || { echo 'Docker не установлен' >&2; exit 1; }",
    'docker rm -f "$C" >/dev/null 2>&1 || true',
    'mkdir -p "$D"',
    'chmod 755 "$D"',
    `printf '%s' '${b64(stubPage(token))}' | base64 -d > "$D/page.html"`,
    `printf '%s' '${b64(HANDLER)}' | base64 -d > "$D/handler.sh"`,
    `printf '%s' '${b64(RUNNER)}' | base64 -d > "$D/run.sh"`,
    'chmod 755 "$D/handler.sh" "$D/run.sh"',
    'touch "$D/hits.log"',
    'chmod 644 "$D/page.html" "$D/hits.log"',
    'listening() {',
    '  if command -v ss >/dev/null 2>&1; then ss -Hlntu | awk \'{print $5}\' | sed \'s/.*://\'',
    "  else netstat -lntu 2>/dev/null | awk 'NR>2 {print $4}' | sed 's/.*://'; fi",
    '}',
    'used=$(listening | sort -u)',
    'port=',
    `for p in ${ports}; do`,
    '  if ! printf \'%s\\n\' "$used" | grep -qx "$p"; then port=$p; break; fi',
    'done',
    "[ -n \"$port\" ] || { echo 'Нет свободного порта для заглушки' >&2; exit 1; }",
    'echo "$port" > "$D/port"',
    `docker run -d --name "$C" --restart always --network host -v "$D:/data" ${STUB_IMAGE} sh /data/run.sh >/dev/null`,
    'if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then',
    '  ufw allow "$port/tcp" >/dev/null 2>&1 || true',
    '  ufw allow "$port/udp" >/dev/null 2>&1 || true',
    'elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then',
    '  firewall-cmd --permanent --add-port="$port/tcp" >/dev/null 2>&1 || true',
    '  firewall-cmd --permanent --add-port="$port/udp" >/dev/null 2>&1 || true',
    '  firewall-cmd --reload >/dev/null 2>&1 || true',
    'fi',
    // Первый запуск ставит socat — ждём, пока порт начнёт слушаться
    'i=0',
    'while [ $i -lt 60 ]; do',
    '  if listening | grep -qx "$port"; then echo "---STUB_PORT $port"; exit 0; fi',
    '  i=$((i + 1))',
    '  sleep 1',
    'done',
    "echo 'Заглушка не запустилась:' >&2",
    'docker logs --tail 20 "$C" >&2 2>&1 || true',
    'exit 1',
  ].join('\n');
}

/** Чтение журнала: состояние контейнера и последние записи */
export function stubReadScript(): string {
  return [
    `echo "RUNNING $(docker inspect -f '{{.State.Running}}' ${STUB_CONTAINER} 2>/dev/null || echo false)"`,
    `tail -n 3000 ${STUB_DIR}/hits.log 2>/dev/null || true`,
  ].join('\n');
}

export function stubRemoveScript(): string {
  return `docker rm -f ${STUB_CONTAINER} >/dev/null 2>&1 || true; rm -rf ${STUB_DIR}`;
}

export function parseStubPort(output: string): number | null {
  const port = Number(/^---STUB_PORT (\d{1,5})$/m.exec(output)?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Разбор журнала заглушки. Журнал пишется с данных, пришедших из сети, поэтому берутся только строки строгого формата.
 */
export function parseStubHits(output: string): { running: boolean; hits: StubHit[] } {
  const running = /^RUNNING true$/m.test(output);
  const hits: StubHit[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^(\d{9,11}) (tcp|udp) ([0-9a-fA-F.:]{2,45}) ([A-Za-z0-9/_-]{1,80})$/.exec(line);
    if (!m) continue;
    // socat записывает IPv4 клиента IPv6-сокета как ::ffff:a.b.c.d
    const ip = m[3].replace(/^::ffff:/i, '');
    hits.push({ at: Number(m[1]), proto: m[2] as 'tcp' | 'udp', ip, path: m[4] === '-' ? '' : m[4] });
  }
  return { running, hits };
}
