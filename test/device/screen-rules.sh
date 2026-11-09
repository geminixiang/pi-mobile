#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
SERIAL=$1
PORT=$2
front() { "$ADB" -s "$SERIAL" shell am start -n dev.geminixiang.pimobile/.MainActivity >/dev/null 2>&1; sleep 2; }
failed=0

front
sh .pi/skills/device-testing/scripts/forward.sh "$SERIAL" "$PORT" >/dev/null
nfc=$(CDP_PORT=$PORT ./test/device/ui.sh 'async () => {
	const { PhoneState } = window.Capacitor.Plugins;
	const before = (await PhoneState.connections()).nfc;
	if (before !== "on" && before !== "off") return "skip: no NFC";
	const result = await PhoneState.setConnection({ what: "nfc", on: before === "off", mayOpen: true });
	await sleep(4000);
	const after = (await PhoneState.connections()).nfc;
	return `${result.outcome} ${before} ${after}`;
}' | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")))')
"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_BACK
case "$nfc" in
	skip*) echo "$nfc" ;;
	"panel on on" | "panel off off") echo "ok: connections opened the NFC panel and left the switch to the user" ;;
	*) echo "FAIL: connections answered $nfc"; failed=1 ;;
esac

ask_in_background() {
	front
	local out
	out=$(mktemp)
	CDP_PORT=$PORT ./test/device/ui.sh "async () => {
	const rt = window.piRuntime; await until(() => rt, 40000); await sleep(1000);
	const name = '背景測試';
	await rt.createBot({ name, job: '', avatar: 'coder' });
	const id = (await rt.bots()).find((bot) => bot.name === name).id;
	for (const set of await rt.toolsets(id)) if (set.kind === 'builtin' && set.id !== '$1') await rt.setToolset(id, set.id, false);
	click('Bot 列表'); await sleep(600);
	[...document.querySelectorAll('.drawer-open')].find((button) => button.textContent.includes(name)).click(); await sleep(1500);
	type('$2'); await sleep(200); click('送出');
	await until(() => busy(), 20000); await until(() => !busy(), 300000); await sleep(800);
	document.querySelectorAll('.work-line[aria-expanded=false]').forEach((line) => line.click());
	await sleep(300);
	const steps = [...document.querySelectorAll('.step')].map((row) => row.dataset.tool + ': ' + row.innerText.replace(/\\s+/g, ' ').slice(0, 100));
	const answer = [...document.querySelectorAll('.answer')].at(-1)?.innerText ?? '';
	await rt.removeBot(id);
	return [...steps, 'answer: ' + answer.slice(0, 200)].join('\\n');
}" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")))' > "$out" &
	sleep 3
	"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_HOME
	wait
	cat "$out"
	rm -f "$out"
}

steps=$(ask_in_background apps "用地圖查台北車站到台北 101 怎麼走")
echo "$steps"
top=$("$ADB" -s "$SERIAL" shell dumpsys activity activities | grep -m1 topResumedActivity)
front
maps=$(echo "$steps" | grep "open_maps" || true)
case "$maps|$top" in
	"|"*) echo "FAIL: the bot never called open_maps"; failed=1 ;;
	*com.google.android.apps.maps*) echo "FAIL: a bot without 代你操作 App opened Maps while pi was in the background"; failed=1 ;;
	*失敗*) echo "ok: a bot without 代你操作 App could not open Maps from the background" ;;
	*) echo "FAIL: open_maps did not fail while pi was in the background"; failed=1 ;;
esac

wifi=$(CDP_PORT=$PORT ./test/device/ui.sh 'async () => (await window.Capacitor.Plugins.PhoneState.connections()).wifi.on' | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")))')
if [ "$wifi" = "true" ]; then
	steps=$(ask_in_background phone_control "把 Wi-Fi 打開")
	echo "$steps"
	front
	case "$(echo "$steps" | grep "connections" || true)" in
		"") echo "FAIL: the bot never called connections"; failed=1 ;;
		*失敗*) echo "FAIL: connections failed though Wi-Fi was already on"; failed=1 ;;
		*) echo "ok: connections answered that Wi-Fi was already on while pi was in the background" ;;
	esac
else
	echo "skip: Wi-Fi is off"
fi
exit $failed
