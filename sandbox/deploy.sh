#!/bin/sh
# Install or update a remote sandbox host over SSH: copies sandbox/ and the pi-env daemon, then runs install.sh there.
# For this machine, run sandbox/install.sh directly.
# Usage: sandbox/deploy.sh <ssh target>
set -e
TARGET="${1:?usage: sandbox/deploy.sh <ssh target>}"
cd "$(dirname "$0")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R Dockerfile install.sh egress relay "$STAGE/"
rm -rf "$STAGE/relay/node_modules"
cp ../node_modules/@earendil-works/pi-env/bin/pi-env-linux-arm64/pi-env "$STAGE/pi-env"
ssh "$TARGET" 'rm -rf ~/.pi-sandbox-install && mkdir -p ~/.pi-sandbox-install'
scp -qr "$STAGE"/. "$TARGET:.pi-sandbox-install/"
ssh -t "$TARGET" 'sh ~/.pi-sandbox-install/install.sh'
