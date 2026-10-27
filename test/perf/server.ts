import { createServer, type ServerResponse } from "node:http";
import { text as bodyText } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";

const PERF_MODEL = "perf-fixture";
const PORT = Number(process.env.PERF_PORT ?? "8399");
const BURST_MS = 150;
const EVENTS_PER_BURST = 6;
const CHARS_PER_EVENT = 6;

const topics = ["排程", "檔案", "網路", "記憶", "電腦", "日曆", "相簿", "通知", "簡訊", "地圖", "資料庫", "MCP"];

function codeBlock(seed: number): string {
	const lines = Array.from({ length: 14 + (seed % 9) }, (_, line) => `\tconst value${line} = items.filter((item) => item.weight > ${seed + line}).map((item) => item.id * ${line + 1});`);
	return ["```ts", `export function compute${seed}(items: { id: number; weight: number }[]) {`, ...lines, `\treturn value0.length;`, "}", "```"].join("\n");
}

function table(seed: number): string {
	const rows = Array.from({ length: 6 }, (_, row) => `| ${topics[(seed + row) % topics.length]} | ${(seed * 7 + row * 13) % 100} ms | ${row % 2 ? "常駐" : "需要時"} | 第 ${row + 1} 項說明，稍微長一點讓欄位換行 |`);
	return ["| 工具組 | 時間 | 載入 | 說明 |", "|---|---|---|---|", ...rows].join("\n");
}

function mermaid(seed: number): string {
	return ["```mermaid", "flowchart LR", `  A[手機 ${seed}] --> B{有電腦嗎}`, "  B -->|有| C[容器]", "  B -->|沒有| D[手機資料夾]", "  C --> E[結果]", "  D --> E", "```"].join("\n");
}

function paragraph(seed: number, index: number): string {
	const topic = topics[(seed + index) % topics.length];
	return `${topic}的部分：這一段是固定的測試內容，第 ${seed}-${index} 段。它混合中文與 English words，含有 **粗體**、\`inline code\` 和 [連結](https://example.com/${seed}/${index})，長度足以換成好幾行，讓 layout 和捲動都有真實的負擔。Each paragraph wraps across several lines on a 360 px wide screen.`;
}

function answer(seed: number): string {
	const parts = [`## 第 ${seed} 則回答`, paragraph(seed, 0), paragraph(seed, 1)];
	parts.push(["- 第一點：" + topics[seed % topics.length], "- 第二點：比較長的一行清單項目，會在手機上換行成兩行以上", "  - 巢狀項目", "- [x] 已完成的工作", "- [ ] 還沒做的工作"].join("\n"));
	parts.push(codeBlock(seed));
	parts.push(paragraph(seed, 2));
	parts.push(table(seed));
	if (seed % 4 === 1) parts.push(mermaid(seed));
	parts.push(`> 引用：${paragraph(seed, 3)}`);
	parts.push(paragraph(seed, 4));
	return parts.join("\n\n");
}

function lastUserText(body: unknown): string {
	const messages = (body as { messages?: { role: string; content: unknown }[] }).messages ?? [];
	const last = [...messages].reverse().find((message) => message.role === "user");
	if (!last) return "";
	if (typeof last.content === "string") return last.content;
	if (Array.isArray(last.content)) return last.content.map((part: { text?: string }) => part.text ?? "").join("");
	return "";
}

function chunk(content: string | undefined, finish?: string): string {
	const delta = content === undefined ? {} : { content };
	return `data: ${JSON.stringify({ id: "perf", object: "chat.completion.chunk", created: 0, model: PERF_MODEL, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
}

async function stream(response: ServerResponse, text: string, paced: boolean): Promise<void> {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
	response.write(chunk(""));
	const burst = EVENTS_PER_BURST * CHARS_PER_EVENT;
	for (let at = 0; at < text.length; at += paced ? burst : text.length) {
		const piece = text.slice(at, paced ? at + burst : text.length);
		let events = "";
		for (let offset = 0; offset < piece.length; offset += CHARS_PER_EVENT) events += chunk(piece.slice(offset, offset + CHARS_PER_EVENT));
		response.write(events);
		if (paced) await sleep(BURST_MS);
	}
	response.write(chunk(undefined, "stop"));
	response.write(`data: ${JSON.stringify({ id: "perf", object: "chat.completion.chunk", created: 0, model: PERF_MODEL, choices: [], usage: { prompt_tokens: 100, completion_tokens: Math.ceil(text.length / 3), total_tokens: 100 + Math.ceil(text.length / 3) } })}\n\n`);
	response.write("data: [DONE]\n\n");
	response.end();
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

createServer(async (request, response) => {
	if (request.method === "OPTIONS") {
		response.writeHead(204, CORS).end();
		return;
	}
	if (request.url?.endsWith("/v1/models")) {
		response.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: PERF_MODEL }] }));
		return;
	}
	if (request.method === "POST" && request.url?.endsWith("/chat/completions")) {
		const text = lastUserText(JSON.parse(await bodyText(request)));
		const build = /^build (\d+)/.exec(text);
		const streamed = /^stream (\d+)/.exec(text);
		const seed = Number((build ?? streamed)?.[1] ?? "0");
		const reply = streamed ? [answer(seed), answer(seed + 100), answer(seed + 200)].join("\n\n") : answer(seed);
		await stream(response, reply, Boolean(streamed));
		return;
	}
	response.writeHead(404, CORS).end();
}).listen(PORT, "127.0.0.1", () => console.log(`perf model on 127.0.0.1:${PORT}`));
