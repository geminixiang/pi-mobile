#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
SERIAL=$1
PORT=$2
"$ADB" -s "$SERIAL" shell am start -n dev.geminixiang.pimobile/.MainActivity >/dev/null 2>&1
sleep 2
sh .pi/skills/device-testing/scripts/forward.sh "$SERIAL" "$PORT" >/dev/null
steps=$(CDP_PORT=$PORT ./test/device/ui.sh 'async () => {
	const rt = window.piRuntime; await until(() => rt, 40000); await sleep(1000);
	const name = "背景開 App 測試";
	await rt.createBot({ name, job: "", avatar: "coder" });
	const id = (await rt.bots()).find((bot) => bot.name === name).id;
	for (const set of await rt.toolsets(id)) if (set.kind === "builtin" && !["apps", "phone_as_user"].includes(set.id)) await rt.setToolset(id, set.id, false);
	click("Bot 列表"); await sleep(600);
	[...document.querySelectorAll(".drawer-open")].find((button) => button.textContent.includes(name)).click(); await sleep(1500);
	type("先打開設定看這支手機的 Android 版本，再用地圖查台北車站到台北 101 怎麼走"); await sleep(200); click("送出");
	await until(() => busy(), 20000); await until(() => !busy(), 600000); await sleep(800);
	document.querySelectorAll(".work-line[aria-expanded=false]").forEach((line) => line.click());
	await sleep(300);
	const steps = [...document.querySelectorAll(".step")].map((row) => row.dataset.tool + ": " + row.innerText.replace(/\s+/g, " ").slice(0, 100));
	await rt.removeBot(id);
	return steps.join("\n");
}' | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")))')
echo "$steps"
"$ADB" -s "$SERIAL" shell am start -n dev.geminixiang.pimobile/.MainActivity >/dev/null 2>&1
maps=$(echo "$steps" | grep "open_maps" || true)
case "$maps" in
	"") echo "FAIL: the bot never called open_maps"; exit 1 ;;
	*失敗*) echo "FAIL: open_maps failed while pi was behind Settings"; exit 1 ;;
	*) echo "ok: open_maps opened Maps while pi was behind Settings" ;;
esac
