#!/bin/sh
# Point a local port at pi's WebView DevTools socket on a device. Run again after every reinstall, app restart,
# force stop, or `adb root`/`unroot`: each one changes the pid in the socket's name or drops the forward.
# Usage: forward.sh <adb serial> [port, default 9333]
set -e
SERIAL="$1"
PORT="${2:-9333}"
ADB="$HOME/Library/Android/sdk/platform-tools/adb -s $SERIAL"
PID=$($ADB shell pidof dev.geminixiang.pimobile | tr -d '\r')
[ -n "$PID" ] || { echo "pi is not running on $SERIAL" >&2; exit 1; }
$ADB forward --remove tcp:$PORT 2>/dev/null || true
$ADB forward tcp:$PORT localabstract:webview_devtools_remote_$PID > /dev/null
curl -s -m 3 "127.0.0.1:$PORT/json" > /dev/null && echo "DevTools of pid $PID on tcp:$PORT"
