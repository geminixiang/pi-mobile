import assert from "node:assert/strict";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import { PHONE_ONLY } from "../../src/agent/toolsets.ts";
import { turn } from "./fixtures.ts";
import { type Check, platform, settings } from "./setup.ts";

async function seen(phone: typeof platform.phone) {
	const runtime = await AgentRuntime.open(new MemoryStorage(), settings, { ...platform, phone });
	try {
		const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
		let offered = "";
		await turn(runtime, bot, [
			(context: TranscriptContext) => {
				offered = JSON.stringify(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		return { offered, toolsets: (await runtime.toolsets(bot)).map((toolset) => toolset.id), place: runtime.workplaces.at(String(bot))?.kind };
	} finally {
		await runtime.close();
	}
}

export const checks: Check[] = [
	[
		"in a browser the bot is not offered phone tools, schedules, or a phone folder",
		async () => {
			const browser = await seen(undefined);
			assert.deepEqual(browser.toolsets.filter((id) => PHONE_ONLY.has(id)), []);
			assert.notEqual(browser.place, "phone");
			for (const tool of ["device_info", "create_schedule", "read_calendar_events", "find_photos"]) assert.doesNotMatch(browser.offered, new RegExp(`\\b${tool}\\b`));
			assert.match(browser.offered, /web browser/);

			const phone = await seen(platform.phone);
			assert.equal(phone.place, "phone");
			for (const tool of ["device_info", "create_schedule", "read_calendar_events", "find_photos"]) assert.match(phone.offered, new RegExp(`\\b${tool}\\b`));
			assert.match(phone.offered, /app on the user's phone/);
		},
	],
];
