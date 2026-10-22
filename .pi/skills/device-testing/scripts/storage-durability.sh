#!/bin/bash
# Whether the WebView's own storage (OPFS and IndexedDB, where pi keeps its conversations) survives what Android does
# to an app: a force stop, the system trimming caches, an app update, and nearly full storage. Writes a marker into
# each, then checks it after every step. EMULATOR ONLY: it uses root, fills the disk, and trims every app's caches.
# Usage: storage-durability.sh <emulator serial> <port> [apk to reinstall, default pi-mobile.apk]
set -e
cd "$(dirname "$0")/../../../.."
SERIAL=$1
PORT=$2
APK=${3:-pi-mobile.apk}
[ -n "$SERIAL" ] && [ -n "$PORT" ] || { echo "usage: storage-durability.sh <emulator serial> <port> [apk]" >&2; exit 1; }
case "$SERIAL" in emulator-*) ;; *) echo "emulator only: $SERIAL" >&2; exit 1 ;; esac
ADB="$HOME/Library/Android/sdk/platform-tools/adb -s $SERIAL"
APP=dev.geminixiang.pimobile
FORWARD="$(dirname "$0")/forward.sh"
page() { CDP_PORT=$PORT ./test/ui.sh "$1"; }
reopen() {
	$ADB shell am start -n $APP/.MainActivity > /dev/null 2>&1
	sleep 6
	"$FORWARD" "$SERIAL" "$PORT" > /dev/null
	sleep 2
}
check() {
	reopen
	echo "$1: $(page 'async () => {
		const opfs = await (async () => { try { return "opfs " + (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("durability")).getFileHandle("marker.txt")).getFile()).size; } catch (e) { return "opfs GONE " + e.name; } })();
		const idb = await new Promise((r) => { const q = indexedDB.open("durability-check"); q.onupgradeneeded = () => q.result.createObjectStore("s"); q.onsuccess = () => { const db = q.result; try { const g = db.transaction("s").objectStore("s").get("marker"); g.onsuccess = () => { r(g.result ? "idb " + g.result.length : "idb GONE"); db.close(); }; } catch { r("idb GONE"); db.close(); } }; });
		return opfs + ", " + idb;
	}' | tr -d '\n')"
}
cleanup() { page 'async () => { await (await navigator.storage.getDirectory()).removeEntry("durability", { recursive: true }).catch(() => {}); indexedDB.deleteDatabase("durability-check"); return "cleaned"; }' > /dev/null || true; }

"$FORWARD" "$SERIAL" "$PORT" > /dev/null
page 'async () => {
	const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("durability", { create: true });
	const w = await (await dir.getFileHandle("marker.txt", { create: true })).createWritable(); await w.write("x".repeat(300000)); await w.close();
	await new Promise((r) => { const q = indexedDB.open("durability-check"); q.onupgradeneeded = () => q.result.createObjectStore("s"); q.onsuccess = () => { const t = q.result.transaction("s", "readwrite"); t.objectStore("s").put("y".repeat(300000), "marker"); t.oncomplete = () => { q.result.close(); r(); }; }; });
	return "written";
}' > /dev/null
check "baseline"
$ADB shell am force-stop $APP; check "force stop"
$ADB shell pm trim-caches 999G; check "pm trim-caches"
$ADB install -r "$APK" > /dev/null; check "app update"
$ADB root > /dev/null; sleep 3
free=$($ADB shell df -k /data | tail -1 | awk '{print $4}')
$ADB shell "dd if=/dev/zero of=/data/local/tmp/fill bs=1048576 count=$(( (free - 150 * 1024) / 1024 )) 2>/dev/null"
$ADB shell df -h /data | tail -1
$ADB shell am force-stop $APP; $ADB shell pm trim-caches 999G
check "storage nearly full, caches trimmed"
$ADB shell rm /data/local/tmp/fill
$ADB unroot > /dev/null; sleep 3
"$FORWARD" "$SERIAL" "$PORT" > /dev/null
cleanup
