#!/bin/sh
# Send one casual prompt in a new conversation and report what the agent did: the tools it called (as the UI labels
# them), the approval it asked for (always declined, so nothing is written), and the start of its answer.
# A prompt starting with "+" continues the current conversation instead of starting a new one.
# Usage: CDP_PORT=9334 test/colloquial.sh '附近有啥好喝的咖啡'
cd "$(dirname "$0")/.."
case "$1" in
	+*) NEW=false; TEXT=${1#+} ;;
	*) NEW=true; TEXT=$1 ;;
esac
PROMPT=$(printf '%s' "$TEXT" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0, "utf8")))')
exec ./test/ui.sh "async () => {
	if ($NEW) { click('新對話'); await sleep(1500); }
	const before = document.querySelectorAll('.step-head').length;
	type($PROMPT); await sleep(200); click('送出'); await sleep(2500);
	const approvals = [];
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline) {
		const decline = [...document.querySelectorAll('button')].find((b) => b.textContent === '拒絕');
		if (decline) {
			approvals.push((document.querySelector('[role=dialog]') ?? decline.closest('div'))?.innerText.replace(/\\n+/g, ' ').slice(0, 160));
			decline.click(); await sleep(1500); continue;
		}
		if (!busy()) break;
		await sleep(700);
	}
	const answers = [...document.querySelectorAll('.answer .markdown')].map((m) => m.innerText.trim()).filter(Boolean);
	return {
		steps: [...document.querySelectorAll('.step-head')].slice(before).map((s) => s.innerText.replace(/\\n/g, ' ').slice(0, 90)),
		approvals,
		answer: (answers.at(-1) ?? '').replace(/\\n+/g, ' / ').slice(0, 260),
	};
}"
