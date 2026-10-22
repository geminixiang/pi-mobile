#!/bin/sh
# Install or update the sandbox host on this machine: sandbox and egress images, the relay as a login service, and
# the secrets. Prints a pairing link and QR code for the app at the end.
#
#   macOS: Docker runs in a dedicated colima VM (profile pi-sandbox), the relay runs under launchd.
#   Linux: rootless Docker for the current user, the relay runs as a systemd user service.
#
# Usage, on the host: sandbox/install.sh            (needs Node 22+, Docker or colima, Tailscale)
#        from elsewhere: sandbox/deploy.sh <ssh target>   (copies this directory and runs it there)
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/pi-sandbox"
CONFIG="$HOME/.config/pi-sandbox"
ENV_FILE="$CONFIG/env"
OS="$(uname -s)"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
random() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

say "Copying files to $DIR"
mkdir -p "$DIR/image" "$DIR/egress" "$DIR/relay" "$CONFIG"
cp "$SRC/Dockerfile" "$DIR/image/Dockerfile"
cp "$SRC/pi-env" "$DIR/image/pi-env" 2>/dev/null || cp "$SRC/../node_modules/@earendil-works/pi-env/bin/pi-env-linux-arm64/pi-env" "$DIR/image/pi-env"
cp "$SRC/egress/Dockerfile" "$SRC/egress/credentials.py" "$SRC/egress/bridge.py" "$DIR/egress/"
cp "$SRC/relay/server.js" "$SRC/relay/pair.js" "$SRC/relay/package.json" "$DIR/relay/"

if [ "$OS" = Darwin ]; then
	PROFILE=pi-sandbox
	if ! colima status -p "$PROFILE" >/dev/null 2>&1; then
		say "Starting colima VM '$PROFILE' (4 CPUs, 4 GiB, 40 GiB disk)"
		colima start -p "$PROFILE" --cpu 4 --memory 4 --disk 40 --vm-type vz --runtime docker --mount-type virtiofs >/dev/null
	fi
	DOCKER_HOST="unix://$HOME/.colima/$PROFILE/docker.sock"
else
	DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
	export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
export DOCKER_HOST

say "Building images (the first build takes a few minutes)"
docker build -q -t pi-sandbox "$DIR/image" >/dev/null
docker build -q -t pi-egress "$DIR/egress" >/dev/null
(cd "$DIR/relay" && npm install --ignore-scripts --no-audit --no-fund --silent)

if [ ! -f "$ENV_FILE" ]; then
	umask 077
	printf 'RELAY_HOST=%s\nRELAY_PORT=8787\nRELAY_TOKEN=%s\n' "$(tailscale ip -4 | head -1)" "$(random)" > "$ENV_FILE"
fi
grep -q '^EGRESS_SECRET=' "$ENV_FILE" || printf 'EGRESS_SECRET=%s\n' "$(random)" >> "$ENV_FILE"
grep -q '^DOCKER_HOST=' "$ENV_FILE" || printf 'DOCKER_HOST=%s\n' "$DOCKER_HOST" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

NODE="$(command -v node)"
if [ "$OS" = Darwin ]; then
	say "Installing the relay as a launchd agent"
	PLIST="$HOME/Library/LaunchAgents/dev.geminixiang.pi-sandbox-relay.plist"
	mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
	cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.geminixiang.pi-sandbox-relay</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string><string>-c</string>
		<string>PATH=/opt/homebrew/bin:/usr/local/bin:\$PATH; colima status -p pi-sandbox >/dev/null 2>&amp;1 || colima start -p pi-sandbox; exec "$NODE" --env-file="$ENV_FILE" "$DIR/relay/server.js"</string>
	</array>
	<key>WorkingDirectory</key><string>$DIR/relay</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>StandardOutPath</key><string>$HOME/Library/Logs/pi-sandbox-relay.log</string>
	<key>StandardErrorPath</key><string>$HOME/Library/Logs/pi-sandbox-relay.log</string>
</dict>
</plist>
EOF
	launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
	say "Installing the relay as a systemd user service"
	mkdir -p "$HOME/.config/systemd/user"
	cat > "$HOME/.config/systemd/user/pi-sandbox-relay.service" <<EOF
[Unit]
Description=pi sandbox relay
After=docker.service

[Service]
WorkingDirectory=$DIR/relay
ExecStart=$NODE --env-file=$ENV_FILE $DIR/relay/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
	systemctl --user daemon-reload
	systemctl --user enable pi-sandbox-relay.service >/dev/null 2>&1
	systemctl --user restart pi-sandbox-relay.service
fi

say "Waiting for the relay"
. "$ENV_FILE"
for _ in $(seq 1 30); do
	curl -fs "http://$RELAY_HOST:$RELAY_PORT/health" >/dev/null 2>&1 && break
	sleep 1
done
curl -fs "http://$RELAY_HOST:$RELAY_PORT/health" >/dev/null || { echo "The relay did not start; see its log."; exit 1; }

"$NODE" --env-file="$ENV_FILE" "$DIR/relay/pair.js"
