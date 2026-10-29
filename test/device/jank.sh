#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
SERIAL=$1
PORT=$2
LABEL=${3:-run}
CDP_PORT=$PORT ./test/device/ui.sh 'async () => { const sc = document.querySelector(".transcript"); sc.scrollTop = 1e9; await sleep(1000); window.__frames = []; let last = performance.now(); const t0 = last; const tick = (now) => { window.__frames.push([Math.round(now - last), Math.round(sc.scrollTop)]); last = now; if (now - t0 < 7000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 1; }' >/dev/null
for _ in 1 2 3; do
	"$ADB" -s "$SERIAL" shell input swipe 540 800 540 1900 100
	sleep 2
done
sleep 1
CDP_PORT=$PORT ./test/device/ui.sh "async () => { const f = window.__frames; const ms = f.filter((x, i) => i > 0 && x[1] !== f[i - 1][1]).map((x) => x[0]).sort((a, b) => a - b); const p = (q) => ms[Math.floor(q * (ms.length - 1))]; return { label: '$LABEL', moving: ms.length, over25: ms.filter((x) => x > 25).length, over40: ms.filter((x) => x > 40).length, p50: p(0.5), p95: p(0.95), max: ms.at(-1), travelled: f[0][1] - f.at(-1)[1] }; }"
