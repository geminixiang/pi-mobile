#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
SERIAL=$1
PORT=$2
PACKAGE=dev.geminixiang.pimobile
SHORTCUTS=$(node -e 'for (const p of JSON.parse(require("fs").readFileSync("test/plugins.snapshot.json", "utf8"))) for (const m of Object.keys(p.methods)) if (/^open\w*Settings$|^openAppInfo$/.test(m)) console.log(p.name + "." + m)')
failed=0
for shortcut in $SHORTCUTS; do
	"$ADB" -s "$SERIAL" shell am start -n $PACKAGE/.MainActivity >/dev/null 2>&1
	sleep 3
	sh .pi/skills/device-testing/scripts/forward.sh "$SERIAL" "$PORT" >/dev/null
	before=$("$ADB" -s "$SERIAL" shell pidof $PACKAGE)
	CDP_PORT=$PORT ./test/device/ui.sh "async () => { window.Capacitor.Plugins.${shortcut%.*}.${shortcut#*.}(); await sleep(300); return 1; }" >/dev/null 2>&1 || true
	sleep 2
	after=$("$ADB" -s "$SERIAL" shell pidof $PACKAGE || true)
	if [ "$before" = "$after" ]; then echo "ok $shortcut"; else echo "pi died: $shortcut"; failed=1; fi
done
"$ADB" -s "$SERIAL" shell am start -n $PACKAGE/.MainActivity >/dev/null 2>&1
exit $failed
