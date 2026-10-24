#!/bin/bash
# Тестовая «VPS»: Docker-in-Docker с SSH. Запускает dockerd, ждёт готовности и отдаёт управление sshd.
/usr/local/bin/dockerd-entrypoint.sh dockerd &

while ! docker info >/dev/null 2>&1; do
  sleep 1
done

echo "Dockerd is ready, starting sshd..."
exec /usr/sbin/sshd -D
