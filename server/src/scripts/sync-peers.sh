#!/bin/bash
set -e

# ==============================================================================
# Demension Panel - AmneziaWG Peer Synchronizer & Stats Collector
# ==============================================================================

CONTAINER_NAME="amnezia-awg"
CONFIG_PATH="/opt/amnezia/awg/awg0.conf"

ACTION=${1:-"sync"}

if [ "$ACTION" = "sync" ]; then
  # Live hot-reloading peers without dropping active connections
  docker exec $CONTAINER_NAME bash -c "awg syncconf awg0 <(awg-quick strip $CONFIG_PATH)"
  echo '{"status":"synced"}'

elif [ "$ACTION" = "dump" ]; then
  # Collect live stats from AmneziaWG interface
  # Output format of awg show awg0 dump:
  # private-key public-key listen-port fwmark
  # peer-pubkey psk endpoint allowed-ips latest-handshake rx-bytes tx-bytes persistent-keepalive
  DUMP=$(docker exec $CONTAINER_NAME awg show awg0 dump 2>/dev/null || true)
  echo "$DUMP"

elif [ "$ACTION" = "status" ]; then
  RUNNING=$(docker inspect -f '{{.State.Running}}' $CONTAINER_NAME 2>/dev/null || echo "false")
  UPTIME=$(docker inspect -f '{{.State.StartedAt}}' $CONTAINER_NAME 2>/dev/null || echo "")
  echo "{\"running\":$RUNNING,\"startedAt\":\"$UPTIME\"}"
fi
