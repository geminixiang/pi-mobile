#!/bin/sh
# Build the web app, sync it into the Android project, and assemble a minified release APK (sideload-signed).
set -e
cd "$(dirname "$0")/.."
npx tsc --noEmit
npx vite build --logLevel warn
npx cap sync android > /dev/null
(cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease --console=plain -q --warning-mode=none)
cp android/app/build/outputs/apk/release/app-release.apk pi-mobile.apk
echo "built pi-mobile.apk"
