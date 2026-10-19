#!/bin/sh
# Build a publishable APK: release-signed with the key in ~/.config/pi-mobile (see release.env), no WebView remote
# debugging, version from package.json. Writes pi-mobile-<version>.apk and prints its SHA-256.
# Usage: scripts/release-android.sh
set -e
cd "$(dirname "$0")/.."
ENV_FILE="${PI_MOBILE_RELEASE_ENV:-$HOME/.config/pi-mobile/release.env}"
[ -f "$ENV_FILE" ] || { echo "No release key: $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
VERSION=$(node -p 'require("./package.json").version')
# 0.1.0 -> 100, 1.2.3 -> 10203: increases with every version.
export PI_MOBILE_VERSION_NAME="$VERSION"
export PI_MOBILE_VERSION_CODE=$(node -p '"'"$VERSION"'".split(".").reduce((code, part) => code * 100 + Number(part), 0)')
npx tsc --noEmit
npx vite build --logLevel warn
npx cap sync android > /dev/null
grep -q '"webContentsDebuggingEnabled": false' android/app/src/main/assets/capacitor.config.json || { echo "remote debugging is on"; exit 1; }
(cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease --console=plain -q --warning-mode=none)
OUT="pi-mobile-$VERSION.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "built $OUT ($PI_MOBILE_VERSION_NAME, code $PI_MOBILE_VERSION_CODE)"
shasum -a 256 "$OUT"
