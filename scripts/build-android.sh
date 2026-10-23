#!/bin/sh
# Build the web app, sync it into the Android project, and assemble a minified release APK with WebView remote
# debugging on, for development (scripts/release-android.sh builds the published one).
#
# With the release key (~/.config/pi-mobile/release.env, docs/releases/README.md) it is signed as releases are, and
# numbered as package.json's version: a release installs over it and it over a release, keeping the phone's data.
# Without the key it is signed with the local debug key; such a build and a release cannot replace each other.
set -e
cd "$(dirname "$0")/.."
ENV_FILE="${PI_MOBILE_RELEASE_ENV:-$HOME/.config/pi-mobile/release.env}"
if [ -f "$ENV_FILE" ]; then
	set -a; . "$ENV_FILE"; set +a
	VERSION=$(node -p 'require("./package.json").version')
	export PI_MOBILE_VERSION_NAME="$VERSION-dev"
	export PI_MOBILE_VERSION_CODE=$(node -p '"'"$VERSION"'".split(".").reduce((code, part) => code * 100 + Number(part), 0)')
fi
npx tsc --noEmit
npx vite build --logLevel warn
PI_MOBILE_DEBUG=1 npx cap sync android > /dev/null
(cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease --console=plain -q --warning-mode=none)
cp android/app/build/outputs/apk/release/app-release.apk pi-mobile.apk
echo "built pi-mobile.apk${PI_MOBILE_VERSION_NAME:+ ($PI_MOBILE_VERSION_NAME, release key)}"
