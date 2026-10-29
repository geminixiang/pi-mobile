#!/bin/bash
set -e
cd "$(dirname "$0")/../../../.."
PORT=$1
TOOLSET=$2
[ -n "$PORT" ] && [ -n "$TOOLSET" ] || { echo "usage: toolset-cost.sh <port> <toolset id>" >&2; exit 1; }
CDP_PORT=$PORT ./test/device/ui.sh "async () => {
	const rt = window.piRuntime;
	await until(() => rt, 40000);
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
		await sleep(1500);
		const n = view?.entries?.length ?? 0;
		type('你好，一個字回答');
		await sleep(500);
		click('送出');
		await until(() => busy(), 20000).catch(() => 0);
		await until(() => !busy(), 120000);
		await sleep(800);
		stop();
		const usage = (view?.entries ?? []).slice(n).find((e) => e.kind === 'pi.assistant')?.model?.[0]?.usage;
		return usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
	};
	const on = await rt.createBot({ name: '量測開', job: '', avatar: 'coder' });
	const off = await rt.createBot({ name: '量測關', job: '', avatar: 'coder' });
	try {
		await rt.setToolset(on, '$TOOLSET', true);
		await rt.setToolset(off, '$TOOLSET', false);
		const withIt = await prompt('量測開');
		const without = await prompt('量測關');
		return { toolset: '$TOOLSET', withIt, without, adds: withIt - without };
	} finally {
		await rt.removeBot(on);
		await rt.removeBot(off);
	}
}"
