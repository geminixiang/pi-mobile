#!/bin/sh
set -e
cd "$(dirname "$0")/.."
ENV_FILE="${PI_MOBILE_RELEASE_ENV:-$HOME/.config/pi-mobile/release.env}"
[ -f "$ENV_FILE" ] || { echo "No release key: $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
VERSION=$(node -p 'require("./package.json").version')
export PI_MOBILE_VERSION_NAME="$VERSION"
export PI_MOBILE_VERSION_CODE=$(node -p '"'"$VERSION"'".split(".").reduce((code, part) => code * 100 + Number(part), 0)')
npx tsc --noEmit
npx vite build --logLevel warn
npx cap sync android > /dev/null
grep -q '"webContentsDebuggingEnabled": false' android/app/src/main/assets/capacitor.config.json || { echo "remote debugging is on"; exit 1; }
[ -n "$JAVA_HOME" ] || export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
(cd android && ./gradlew assembleRelease --console=plain -q --warning-mode=none)
OUT="pi-mobile-$VERSION.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "built $OUT ($PI_MOBILE_VERSION_NAME, code $PI_MOBILE_VERSION_CODE)"
if command -v sha256sum > /dev/null; then sha256sum "$OUT"; else shasum -a 256 "$OUT"; fi
