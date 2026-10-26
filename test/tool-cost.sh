#!/bin/bash
set -e
cd "$(dirname "$0")/.."
PORT=$1
shift
SERVICES=$(for service in "$@"; do printf '"%s",' "$service"; done)
CDP_PORT=$PORT ./test/ui.sh "async () => {
	const rt = window.piRuntime;
	await until(() => rt, 40000);
	await sleep(1500);
	const open = async (name) => {
		document.querySelector('.brand-button').click();
		await sleep(600);
		[...document.querySelectorAll('.drawer-open')].find((b) => b.textContent.includes(name)).click();
		await sleep(1500);
	};
	const prompt = async (name) => {
		await open(name);
		let view;
		const stop = window.piController.subscribe((v) => (view = v));
		await sleep(300);
		const n = view?.entries?.length ?? 0;
		type('你好，一個字回答');
		await sleep(200);
		click('送出');
		await until(() => busy(), 20000).catch(() => 0);
		await until(() => !busy(), 120000);
		await sleep(800);
		stop();
		const usage = (view?.entries ?? []).slice(n).find((e) => e.kind === 'pi.assistant')?.model?.[0]?.usage;
		return usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
	};
	await rt.createBot({ name: '量測全開', job: '', avatar: 'coder' });
	await rt.createBot({ name: '量測全關', job: '', avatar: 'coder' });
	const bots = await rt.bots();
	const full = bots.find((b) => b.name === '量測全開').id;
	const bare = bots.find((b) => b.name === '量測全關').id;
	for (const service of [${SERVICES}]) await rt.setToolset(full, service, true);
	for (const t of await rt.toolsets(bare)) if (t.kind === 'builtin') await rt.setToolset(bare, t.id, false);
	const cost = await rt.toolCost(full);
	const toolsets = await rt.toolsets(full);
	const allOn = await prompt('量測全開');
	const allOff = await prompt('量測全關');
	await rt.removeBot(full);
	await rt.removeBot(bare);
	const rows = Object.entries(cost).map(([extension, c]) => {
		const toolset = toolsets.find((t) => t.extensions.includes(extension));
		const fixed = { triggers: '排程', memory: '記憶', 'tool-search': '工具搜尋', skills: 'skills' }[extension];
		const label = toolset ? toolset.label + (toolset.kind === 'service' ? '（MCP）' : '') : (fixed ?? extension) + '（固定開啟）';
		return { extension, label, load: c.deferred > 0 ? '需要時載入' : '常駐', chars: c.offered + c.deferred, tools: c.tools.length };
	}).sort((a, b) => (a.load === b.load ? b.chars - a.chars : a.load === '常駐' ? -1 : 1));
	const offered = rows.filter((r) => r.load === '常駐').reduce((n, r) => n + r.chars, 0);
	return [
		'| 工具組 | 擴充 | 載入 | 工具數 | 字元 | 約 tokens |',
		'|---|---|---|---:|---:|---:|',
		...rows.map((r) => '| ' + r.label + ' | \`' + r.extension + '\` | ' + r.load + ' | ' + r.tools + ' | ' + r.chars.toLocaleString() + ' | ' + Math.round(r.chars / 4.9).toLocaleString() + ' |'),
		'',
		'常駐的定義合計 ' + offered.toLocaleString() + ' 字元。短請求的提示：內建工具全開 ' + allOn.toLocaleString() + ' tokens，全關 ' + allOff.toLocaleString() + ' tokens。',
	].join('\\n');
}" | python3 -c "import json,sys; print(json.load(sys.stdin))"
