import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, createModels, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { memoryCredentials } from "../../src/agent/credentials.ts";
import { AgentRuntime, type ConversationId } from "../../src/runtime/runtime.ts";
import { defineAppTool, text } from "../../src/agent/tools/common.ts";
import type { InstalledApp } from "../../src/agent/platform.ts";
import { APP_NOTE_LIMITS, createAppNotes } from "../../src/skills/skills.ts";
import { idle, keepOpen, toolResults } from "./fixtures.ts";
import { type Check, faux, phoneApps, platform, settings } from "./setup.ts";

const SHOPEE: InstalledApp = { package: "com.shopee.tw", label: "蝦皮購物", version: "3.41.10" };
const PHONE: InstalledApp[] = [
	SHOPEE,
	{ package: "com.ubercab", label: "Uber", version: "4.500" },
	{ package: "com.ubercab.eats", label: "Uber Eats", version: "6.200" },
	{ package: "jp.naver.line.android", label: "LINE", version: "15.1" },
	{ package: "com.google.android.apps.maps", label: "Google 地圖", version: "25.1" },
];
const SHOPEE_LINE = "[app] Apps for this: 蝦皮購物 (com.shopee.tw, installed)";
const NOTE = "Orders: 我的 › 我的購買 › 待收貨; 查看物流詳情 in an order.";
const NOTE_LABEL = "Your own notes on 蝦皮購物 from earlier use; the live screen overrides them:";

async function send(runtime: AgentRuntime, bot: ConversationId, said: string, steps: FauxResponseStep[]): Promise<void> {
	faux.setResponses(steps);
	const controller = await runtime.openConversation(bot);
	const done = idle(runtime, bot);
	await controller.send([{ type: "text", text: said }]);
	await done;
	controller.dispose();
}

async function asked(runtime: AgentRuntime, bot: ConversationId, said: string): Promise<string[]> {
	let seen: string[] = [];
	await send(runtime, bot, said, [
		(context: TranscriptContext) => {
			seen = context.messages.flatMap((message) => (message.role === "user" ? [contentText(message.content, "\n")] : []));
			return fauxAssistantMessage("done");
		},
	]);
	return seen;
}

const noted = (app: string, note: string, id: string): FauxResponseStep[] => [
	fauxAssistantMessage(fauxToolCall("tool_search", { query: "phone_note_as_user" }, { id: `${id}-search` }), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxToolCall("phone_note_as_user", { app, text: note }, { id }), { stopReason: "toolUse" }),
	fauxAssistantMessage("記下了"),
];

async function onPhone(installed: readonly InstalledApp[], storage: MemoryStorage, run: (runtime: AgentRuntime, bot: ConversationId) => Promise<void>, existing?: ConversationId): Promise<ConversationId> {
	phoneApps.installed = [...installed];
	phoneApps.asked = 0;
	const runtime = await AgentRuntime.open(storage, settings, platform);
	try {
		const bot = existing ?? (await runtime.createBot({ name: "tmp", job: "", avatar: "helper" }));
		if (!existing) for (const opening of ["嗨", "在嗎"]) await asked(runtime, bot, opening);
		await run(runtime, bot);
		return bot;
	} finally {
		await runtime.close();
	}
}

export const checks: Check[] = [
	[
		"a request that names an installed app by its label carries one line naming it, earlier requests stay as they were, and the phone is asked once",
		async () => {
			await onPhone(PHONE, new MemoryStorage(), async (runtime, bot) => {
				const first = (await asked(runtime, bot, "蝦皮包裹到哪了")).at(-1) ?? "";
				assert.ok(first.endsWith(`蝦皮包裹到哪了\n${SHOPEE_LINE}`), first);
				assert.equal((await asked(runtime, bot, "那退貨呢")).at(-2), first, "an earlier request is sent the same way again, so the cached prefix holds");
				assert.ok(!(await asked(runtime, bot, "今天天氣如何")).at(-1)?.includes("[app]"));
				assert.ok((await asked(runtime, bot, "Uber Eats 的訂單呢")).at(-1)?.endsWith("[app] Apps for this: Uber Eats (com.ubercab.eats, installed)"));
				assert.ok((await asked(runtime, bot, "開地圖看路線")).at(-1)?.endsWith("[app] Apps for this: Google 地圖 (com.google.android.apps.maps, installed)"));
				assert.ok(!(await asked(runtime, bot, "deadline 是不是 online 填")).at(-1)?.includes("[app]"));
				assert.ok(!(await asked(runtime, bot, "momo 的訂單")).at(-1)?.includes("[app]"), "an app that is not installed is not named");
				assert.equal(phoneApps.asked, 1);
			});
		},
	],
	[
		"a bot that may not act as the user is not told about apps",
		async () => {
			await onPhone(PHONE, new MemoryStorage(), async (runtime, bot) => {
				await runtime.setToolset(bot, "phone_as_user", false);
				assert.ok(!(await asked(runtime, bot, "蝦皮包裹到哪了")).at(-1)?.includes("[app]"));
			});
		},
	],
	[
		"a note the bot saved on an app comes with later requests that name it, once, labelled as its own and overridden by the screen; a new app version marks it stale",
		async () => {
			const storage = keepOpen(new MemoryStorage());
			const bot = await onPhone(PHONE, storage, async (runtime, bot) => {
				const before = (await asked(runtime, bot, "蝦皮")).at(-1);
				await send(runtime, bot, "記一下怎麼查物流", noted("com.shopee.tw", NOTE, "note-1"));
				const seen = await asked(runtime, bot, "蝦皮包裹到哪了");
				assert.equal(seen.at(-3), before, "a request from before the note is not changed by it");
				assert.ok(seen.at(-1)?.endsWith(`${SHOPEE_LINE}\n${NOTE_LABEL}\n${NOTE}`), String(seen.at(-1)));
				const later = await asked(runtime, bot, "蝦皮退貨呢");
				assert.equal(later.at(-2), seen.at(-1));
				assert.ok(later.at(-1)?.endsWith(`蝦皮退貨呢\n${SHOPEE_LINE}`), "a note already in the conversation is not attached again");
			});
			await onPhone(PHONE.map((app) => (app === SHOPEE ? { ...app, version: "3.50.0" } : app)), storage, async (runtime) => {
				const said = (await asked(runtime, bot, "蝦皮包裹到哪了")).join("\n");
				assert.ok(said.includes("Your own notes on 蝦皮購物 from earlier use (written for version 3.41.10, now 3.50.0: check it, then save a corrected note); the live screen overrides them:"), said);
			}, bot);
		},
	],
	[
		"a note is saved only for an installed app, within its size, replaced by the next one and deleted by empty text",
		async () => {
			const storage = keepOpen(new MemoryStorage());
			await onPhone(PHONE, storage, async (runtime, bot) => {
				await send(runtime, bot, "記", noted("蝦皮購物", "first", "a"));
				await send(runtime, bot, "記", noted("com.shopee.tw", NOTE, "b"));
				await send(runtime, bot, "記", noted("momo購物", NOTE, "c"));
				await send(runtime, bot, "記", noted("com.shopee.tw", "x".repeat(APP_NOTE_LIMITS.text + 1), "d"));
				const results = (await toolResults(storage, bot)).filter((result) => result.name === "phone_note_as_user").toReversed();
				assert.deepEqual(results.map((result) => result.isError), [false, false, true, true], results.map((result) => result.text).join(" | "));
				assert.match(results[2]?.text ?? "", /not an installed app/);
				const said = (await asked(runtime, bot, "蝦皮")).at(-1) ?? "";
				assert.ok(said.endsWith(NOTE) && !said.includes("first"), said);
				await send(runtime, bot, "忘掉", noted("com.shopee.tw", "", "e"));
				assert.ok((await asked(runtime, bot, "蝦皮 again")).at(-1)?.endsWith(SHOPEE_LINE));
			});
		},
	],
	[
		"a turn started by a schedule cannot save an app note",
		async () => {
			const tool = createAppNotes({ unattended: () => true, apps: { installed: async () => PHONE }, actsAsUser: async () => true }).notes.tools?.find((candidate) => candidate.name === "phone_note_as_user");
			assert(tool);
			// why: the refusal comes before the tool touches its api beyond conversationId; a whole Harness is not what this check is about
			const api = { conversationId: "bot-1" } as unknown as ToolExecutionApi;
			await assert.rejects(tool.execute({ app: SHOPEE.package, text: NOTE }, api, BACKGROUND_CONTEXT), /started from a schedule/);
		},
	],
	[
		"a tool that loads others makes them offered from the next request, without tool_search",
		async () => {
			const inner = defineAppTool({ name: "inner_tool", groups: "always", effect: "read", reach: "loaded", description: "A deferred fixture, offered once loaded.", parameters: Type.Object({}), execute: async () => text("inner") });
			const entry = defineAppTool({ name: "entry_tool", groups: "always", effect: "read", reach: "model", loads: [inner.name], description: "An entry fixture that loads inner_tool.", parameters: Type.Object({}), execute: async () => text("opened") });
			const extension = defineExtension({ name: "fixture", tools: [entry, inner] });
			const registry = createRegistry();
			registry.install(extension);
			const models = createModels({ credentials: await memoryCredentials({ faux: "contract" }, {}) });
			models.setProvider(faux.provider);
			const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { extensions: [extension] } }, BACKGROUND_CONTEXT);
			try {
				const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "model" }, extensions: [extension] } }, BACKGROUND_CONTEXT);
				const offered: string[] = [];
				faux.setResponses([
					(context: TranscriptContext) => {
						offered.push(JSON.stringify(context));
						return fauxAssistantMessage(fauxToolCall("entry_tool", {}), { stopReason: "toolUse" });
					},
					(context: TranscriptContext) => {
						offered.push(JSON.stringify(context));
						return fauxAssistantMessage("done");
					},
				]);
				await conversation.submit({ type: "input", content: [{ type: "text", text: "go" }] }, BACKGROUND_CONTEXT);
				await conversation.waitForIdle(BACKGROUND_CONTEXT);
				const [before, after] = offered;
				assert.ok(before && !before.includes(`"name":"inner_tool"`));
				assert.ok(after?.includes(`"name":"inner_tool"`));
			} finally {
				await harness.close(BACKGROUND_CONTEXT);
			}
		},
	],
];
