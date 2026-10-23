#!/bin/sh
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
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline && busy()) await sleep(700);
	const answers = [...document.querySelectorAll('.answer .markdown')].map((m) => m.innerText.trim()).filter(Boolean);
	return {
		steps: [...document.querySelectorAll('.step-head')].slice(before).map((s) => s.innerText.replace(/\\n/g, ' ').slice(0, 90)),
		answer: (answers.at(-1) ?? '').replace(/\\n+/g, ' / ').slice(0, 260),
	};
}"
