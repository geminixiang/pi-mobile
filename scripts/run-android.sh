#!/bin/sh
# Install pi-mobile.apk on a device, restart the app, and forward its WebView DevTools socket.
# Usage: scripts/run-android.sh <adb serial> [cdp port]
set -e
cd "$(dirname "$0")/.."
SERIAL="$1"
PORT="${2:-9333}"
ADB="$HOME/Library/Android/sdk/platform-tools/adb -s $SERIAL"
APP=dev.geminixiang.pimobile
$ADB install -r pi-mobile.apk > /dev/null
$ADB shell am force-stop $APP
$ADB shell am start -n $APP/.MainActivity > /dev/null
sleep 3
PID=$($ADB shell pidof $APP | tr -d '\r')
$ADB forward --remove tcp:$PORT 2>/dev/null || true
$ADB forward tcp:$PORT localabstract:webview_devtools_remote_$PID > /dev/null
echo "running on $SERIAL, DevTools on tcp:$PORT"
