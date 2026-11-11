#!/bin/sh
set -eu
cd "$(dirname "$0")/../../.."
here=test/device/wayland
out=$(mktemp -d)
arch=$(docker info --format '{{.Architecture}}')
case "$arch" in aarch64 | arm64) arch=arm64 ;; *) arch=amd64 ;; esac
docker build -q -t pi-mobile-wayland "$here" >/dev/null
(cd host && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -o "$out/pi-mobile" .)
container=$(docker create pi-mobile-wayland sh /work/start.sh)
[ -n "${KEEP:-}" ] || trap 'docker rm -f "$container" >/dev/null' EXIT
docker cp "$here/." "$container:/work" >/dev/null
docker cp "$out/pi-mobile" "$container:/work/pi-mobile" >/dev/null
docker start "$container" >/dev/null
for _ in $(seq 60); do docker exec "$container" test -f /tmp/ready 2>/dev/null && break; sleep 1; done
status=0
docker exec "$container" timeout 180 python3 /work/check.py || status=$?
for shot in before wayland; do docker cp "$container:/tmp/$shot.png" "$out/$shot.png" >/dev/null 2>&1 && echo "screenshot: $out/$shot.png"; done
exit "$status"
