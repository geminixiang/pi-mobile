#!/bin/sh
PROVIDER=${1:?usage: model-eval.sh <provider> <model>}
MODEL=${2:?usage: model-eval.sh <provider> <model>}
cd "$(dirname "$0")/../../../.."
./test/device/ui.sh "async () => {
	const rt = window.piRuntime;
	await until(() => rt, 20000);
	const id = await rt.createBot({ name: '模型測試', job: '', avatar: 'helper' });
	window.__evalBot = id;
	return id;
}" > /dev/null
for q in "明天台北會下雨嗎" "這週行事曆有什麼" "附近有什麼咖啡店" "手機電量多少、有在充電嗎" "今天走了幾步" "台積電最近一週股價" "把台北、台中、高雄明天的天氣做成表格" "在我的資料夾建立 todo.md，寫三個待辦，再用 bash 數行數" "查一下 pele 這個 Mermaid 渲染器是什麼" "用流程圖畫出你剛才查三個城市天氣的步驟"; do
	./test/device/ui.sh "async () => {
		const rt = window.piRuntime;
		const id = window.__evalBot;
		const c = await rt.openConversation(id);
		await c.setModel('$PROVIDER', '$MODEL');
		let view;
		const stop = c.subscribe((v) => (view = v));
		await sleep(300);
		const before = view?.entries?.length ?? 0;
		const t = performance.now();
		await c.send([{ type: 'text', text: '$q' }]);
		await sleep(800);
		const fresh = () => (view?.entries ?? []).slice(before);
		await until(() => fresh().some((e) => e.kind === 'pi.assistant' && !(e.model?.[0]?.content ?? []).some((p) => p.type === 'toolCall')), 300000).catch(() => c.stop());
		const ms = Math.round(performance.now() - t);
		const entries = fresh();
		const assistants = entries.filter((e) => e.kind === 'pi.assistant').map((e) => e.model?.[0]).filter(Boolean);
		const calls = assistants.flatMap((m) => m.content.filter((p) => p.type === 'toolCall').map((p) => p.name + ':' + JSON.stringify(p.name === 'codemode' ? p.arguments?.code : p.arguments).slice(0, 400)));
		const errors = entries.filter((e) => e.kind === 'pi.tool-result').flatMap((e) => (e.model ?? []).filter((m) => m.isError).map((m) => (m.content ?? []).map((p) => p.text ?? '').join('').slice(0, 120)));
		const failed = assistants.filter((m) => m.stopReason === 'error').map((m) => String(m.errorMessage).slice(0, 120));
		const usage = assistants.reduce((s, m) => s + (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0), 0);
		const answer = assistants.at(-1)?.content.filter((p) => p.type === 'text').map((p) => p.text).join('').replace(/\\s+/g, ' ').slice(0, 600);
		stop();
		c.dispose();
		const hints = entries.filter((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('Nothing came back')).length;
		return { q: '$q', s: Math.round(ms / 100) / 10, requests: assistants.length, hints, calls, errors, failed, inputTokens: usage, answer };
	}" 2>&1 | tr -d '\n' | sed 's/  */ /g'
	echo
done
./test/device/ui.sh "async () => { await window.piRuntime.removeBot(window.__evalBot); return 'removed'; }"
