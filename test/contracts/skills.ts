import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createSkillsExtension, SKILL_LIMITS } from "../../src/skills/skills.ts";
import { openRuntime, toolResults, turn } from "./fixtures.ts";
import type { Check } from "./setup.ts";

const WEEKLY = { name: "weekly-report", description: "How the Friday report is written. Use when writing it.", text: "1. Wins first.\n2. Then what slipped." };

const save = (args: typeof WEEKLY, id = "save-1") => [fauxAssistantMessage(fauxToolCall("save_skill", args, { id }), { stopReason: "toolUse" }), fauxAssistantMessage("記住了")];

export const checks: Check[] = [
	[
		"a skill the user asked to keep is saved for that bot only, listed in its panel, and read back with read_skill",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot, "the default bot exists");
				const other = await runtime.createBot({ name: "other", job: "", avatar: "helper" });
				await turn(runtime, bot.id, save(WEEKLY), "以後週報都這樣寫");
				assert.deepEqual(await runtime.skills.of(bot.id), [WEEKLY]);
				assert.deepEqual(await runtime.skills.of(other), [], "another bot does not get it");
				let prompt = "";
				await turn(runtime, bot.id, [
					(context: TranscriptContext) => {
						prompt = JSON.stringify(context.messages);
						return fauxAssistantMessage("好");
					},
				]);
				assert.ok(prompt.includes("<name>weekly-report</name>\\n    <description>How the Friday report is written. Use when writing it.</description>"), "available_skills lists the bot's own skill");
				const read = createSkillsExtension({ changed: () => undefined, unattended: () => false }).tools?.find((candidate) => candidate.name === "read_skill");
				assert(read, "read_skill exists");
				// why: read_skill reads only conversationId and one snapshot from its api; the saving above already went through the real runtime
				const api = { conversationId: bot.id, snapshot: async () => ({ skills: await runtime.skills.of(bot.id) }) } as unknown as ToolExecutionApi;
				assert.deepEqual((await read.execute({ name: WEEKLY.name }, api, BACKGROUND_CONTEXT)).output, [{ type: "text", text: `---\nname: ${WEEKLY.name}\ndescription: ${WEEKLY.description}\n---\n\n${WEEKLY.text}` }]);
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"saving a name again replaces it, empty text deletes it, and a built-in name or one skill past the limit is refused",
		async () => {
			const { runtime, storage } = await openRuntime();
			try {
				const [bot] = await runtime.bots();
				assert(bot, "the default bot exists");
				await turn(runtime, bot.id, save(WEEKLY));
				await turn(runtime, bot.id, save({ ...WEEKLY, text: "Wins only." }, "save-2"));
				assert.deepEqual((await runtime.skills.of(bot.id)).map((skill) => skill.text), ["Wins only."]);
				await turn(runtime, bot.id, save({ ...WEEKLY, text: "" }, "save-3"));
				assert.deepEqual(await runtime.skills.of(bot.id), []);
				await turn(runtime, bot.id, save({ ...WEEKLY, name: "html-page" }, "save-4"));
				for (let index = 0; index < SKILL_LIMITS.count + 1; index++) await turn(runtime, bot.id, save({ ...WEEKLY, name: `skill-${index}` }, `fill-${index}`));
				assert.equal((await runtime.skills.of(bot.id)).length, SKILL_LIMITS.count);
				const refused = (await toolResults(storage, bot.id)).filter((result) => result.name === "save_skill" && result.isError).map((result) => result.text);
				assert.ok(refused.some((text) => text.includes("built-in")), refused.join(" | "));
				assert.ok(refused.some((text) => text.includes(`already have ${SKILL_LIMITS.count}`)), refused.join(" | "));
			} finally {
				await runtime.close();
			}
		},
	],
	[
		"a turn started by a schedule cannot save a skill: a notification must not become a standing instruction",
		async () => {
			const tool = createSkillsExtension({ changed: () => undefined, unattended: () => true }).tools?.find((candidate) => candidate.name === "save_skill");
			assert(tool, "save_skill exists");
			// why: the refusal comes before the tool touches its api beyond conversationId; a whole Harness is not what this check is about
			const api = { conversationId: "bot-1" } as unknown as ToolExecutionApi;
			await assert.rejects(tool.execute(WEEKLY, api, BACKGROUND_CONTEXT), /started from a schedule/);
		},
	],
	[
		"removing a bot removes its skills",
		async () => {
			const { runtime } = await openRuntime();
			try {
				const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
				await turn(runtime, bot, save(WEEKLY));
				assert.equal((await runtime.skills.of(bot)).length, 1);
				await runtime.removeBot(bot);
				assert.deepEqual(await runtime.skills.of(bot), []);
			} finally {
				await runtime.close();
			}
		},
	],
];
