#!/bin/sh
# Deploy the sandbox image and relay to the Raspberry Pi's agent account.
# Usage: sandbox/deploy.sh [ssh target]   (default agent@raspberrypi tailnet IP)
set -e
cd "$(dirname "$0")"
TARGET="${1:-agent@100.121.187.60}"
DAEMON=../node_modules/@earendil-works/pi-env/bin/pi-env-linux-arm64/pi-env
ssh "$TARGET" 'mkdir -p ~/pi-sandbox/image ~/pi-sandbox/egress ~/pi-sandbox/relay ~/.config/pi-sandbox ~/.config/systemd/user'
scp -q Dockerfile "$TARGET:pi-sandbox/image/Dockerfile"
scp -q "$DAEMON" "$TARGET:pi-sandbox/image/pi-env"
scp -q egress/Dockerfile egress/github_auth.py "$TARGET:pi-sandbox/egress/"
scp -q relay/server.mjs relay/package.json "$TARGET:pi-sandbox/relay/"
scp -q relay/pi-sandbox-relay.service "$TARGET:.config/systemd/user/"
ssh "$TARGET" '
set -e
export XDG_RUNTIME_DIR=/run/user/$(id -u) DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
cd ~/pi-sandbox/relay && npm install --ignore-scripts --no-audit --no-fund --silent
cd ~/pi-sandbox/image && docker build -q -t pi-sandbox . >/dev/null
cd ~/pi-sandbox/egress && docker build -q -t pi-egress . >/dev/null
if [ ! -f ~/.config/pi-sandbox/env ]; then
  umask 077
  printf "RELAY_HOST=%s\nRELAY_PORT=8787\nRELAY_TOKEN=%s\n" "$(tailscale ip -4)" "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n")" > ~/.config/pi-sandbox/env
fi
if ! grep -q "^EGRESS_SECRET=" ~/.config/pi-sandbox/env; then
  printf "EGRESS_SECRET=%s\n" "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n")" >> ~/.config/pi-sandbox/env
fi
systemctl --user daemon-reload
systemctl --user enable --now pi-sandbox-relay.service >/dev/null 2>&1
systemctl --user restart pi-sandbox-relay.service
sleep 1
systemctl --user --no-pager status pi-sandbox-relay.service | sed -n 1,4p
'
