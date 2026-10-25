#!/usr/bin/env bash
# Управление тестовыми нодами для real-*.test.ts (нужен Docker; контейнеры запускаются с --privileged).
#
#   ./nodes.sh up      собрать образ и запустить dementia-node-1 (SSH 2222) и dementia-node-2 (SSH 2223)
#   ./nodes.sh down    остановить и удалить контейнеры
#   ./nodes.sh status  показать контейнеры и готовность внутреннего Docker
#
# Тесты сами определяют ноды по открытому SSH-порту и пропускаются, если их нет.
set -euo pipefail

IMAGE="dementia-test-node"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

status() {
  docker ps --filter name=dementia-node --format '{{.Names}}	{{.Ports}}	{{.Status}}'
  for node in dementia-node-1 dementia-node-2; do
    if docker exec "$node" docker info >/dev/null 2>&1; then echo "$node: внутренний Docker готов"; else echo "$node: не готов"; fi
  done
}

start() { # start имя ssh-порт udp-порт
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --privileged --name "$1" -p "$2:22" -p "$3:51820/udp" "$IMAGE" >/dev/null
}

case "${1:-}" in
  up)
    docker build -t "$IMAGE" "$HERE"
    start dementia-node-1 2222 51820
    start dementia-node-2 2223 51821
    echo "Ожидание внутреннего Docker на нодах..."
    for node in dementia-node-1 dementia-node-2; do
      for _ in $(seq 1 60); do
        docker exec "$node" docker info >/dev/null 2>&1 && break
        sleep 1
      done
    done
    status
    ;;
  down)
    docker rm -f dementia-node-1 dementia-node-2 >/dev/null 2>&1 || true
    echo "Тестовые ноды удалены."
    ;;
  status)
    status
    ;;
  *)
    echo "Использование: $0 up|down|status" >&2
    exit 1
    ;;
esac
