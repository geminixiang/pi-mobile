#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
SERIAL=$1
PORT=$2
sh .pi/skills/device-testing/scripts/forward.sh "$SERIAL" "$PORT" >/dev/null
CDP_PORT=$PORT ./test/device/ui.sh 'async () => {
	const { Page, Browser } = window.Capacitor.Plugins;
	const cases = [
		["https://example.com/", ""],
		["https://expired.badssl.com/", "certificate"],
		["https://wrong.host.badssl.com/", "certificate"],
		["https://testsafebrowsing.appspot.com/s/phishing.html", "phishing"],
		["https://testsafebrowsing.appspot.com/s/malware.html", "malware"],
	];
	const lines = [];
	for (const [url, expected] of cases) {
		const checked = (await Page.check({ url })).blocked ?? "";
		lines.push(`${expected ? checked.includes(expected) : !checked ? "ok" : "FAIL"} Page.check ${url} ${checked}`.replace(/^true/, "ok").replace(/^false/, "FAIL"));
		const page = await Browser.act({ bot: "risky-pages-test", steps: [{ action: "open", url }, { action: "wait", ms: 3000 }], screenshot: false });
		const shown = page.text.startsWith("[pi blocked") ? page.text.split("\n")[0] : "";
		lines.push(`${expected ? shown.includes(expected) : !shown ? "ok" : "FAIL"} Browser ${url} ${shown}`.replace(/^true/, "ok").replace(/^false/, "FAIL"));
	}
	return lines.join("\n");
}' | node -e 'const lines = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(lines); process.exit(lines.includes("FAIL") ? 1 : 0)'
