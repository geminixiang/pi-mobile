import assert from "node:assert/strict";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { AgentRuntime } from "../../src/agent/runtime.ts";
import { NATIVE_PLUGINS, type NativePlugin } from "../../src/native.ts";
import { turn } from "./fixtures.ts";
import { type Check, platform, settings } from "./setup.ts";

async function seen(inApp: boolean, native: readonly NativePlugin[], missing: readonly string[] = [], off: readonly string[] = []) {
	const runtime = await AgentRuntime.open(new MemoryStorage(), settings, {
		...platform,
		inApp,
		native: { has: (plugin) => native.includes(plugin), implements: ({ plugin, method }) => native.some((name) => name === plugin) && !missing.includes(`${plugin}.${method}`) },
		phone: native.includes("BotFiles") ? platform.phone : undefined,
	});
	try {
		const bot = await runtime.createBot({ name: "tmp", job: "", avatar: "helper" });
		for (const toolset of off) await runtime.setToolset(bot, toolset, false);
		let offered = "";
		await turn(runtime, bot, [
			(context: TranscriptContext) => {
				offered = JSON.stringify(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		const offers = (tool: string) => new RegExp(`\\b${tool}\\b`).test(offered);
		return { offered, offers, toolsets: (await runtime.toolsets(bot)).map((toolset) => toolset.id), place: runtime.workplaces.at(String(bot))?.kind };
	} finally {
		await runtime.close();
	}
}

const NATIVE_TOOLS = ["device_info", "create_schedule", "read_calendar_events", "find_photos", "scan_document"];

export const checks: Check[] = [
	[
		"a bot is offered the tools whose native part this app has, found when it starts",
		async () => {
			const browser = await seen(false, []);
			for (const tool of NATIVE_TOOLS) assert.equal(browser.offers(tool), false, tool);
			for (const id of ["device", "calendar", "files", "database"]) assert.ok(!browser.toolsets.includes(id), id);
			assert.ok(browser.toolsets.includes("web"));
			assert.notEqual(browser.place, "phone");
			assert.match(browser.offered, /web browser/);
			assert.match(browser.offered, /new Date\(\) in codemode/);

			const newApp = await seen(true, ["StreamFetch", "System"]);
			for (const tool of NATIVE_TOOLS) assert.equal(newApp.offers(tool), false, tool);
			assert.notEqual(newApp.place, "phone");
			assert.match(newApp.offered, /app on the user's phone/);
			assert.match(newApp.offered, /new Date\(\) in codemode/);

			const withCalendar = await seen(true, ["Calendar"]);
			assert.ok(withCalendar.offers("read_calendar_events"));
			assert.ok(withCalendar.toolsets.includes("calendar"));
			assert.ok(!withCalendar.toolsets.includes("device"));
			assert.equal(withCalendar.offers("device_info"), false);

			const android = await seen(true, NATIVE_PLUGINS.filter((plugin) => platform.native.has(plugin)));
			for (const tool of NATIVE_TOOLS) assert.ok(android.offers(tool), tool);
			assert.equal(android.place, "phone");
			assert.match(android.offered, /starts each user message with when it was sent/);
		},
	],
	[
		"a tool is offered where every native method it calls is implemented, so a platform can implement a plugin method by method",
		async () => {
			const partial = await seen(true, NATIVE_PLUGINS.filter((plugin) => platform.native.has(plugin)), ["Records.sms", "Calendar.insertEvent"]);
			assert.ok(partial.offers("call_log"));
			assert.equal(partial.offers("read_sms"), false);
			assert.ok(partial.offers("read_calendar_events"));
			assert.equal(partial.offers("add_calendar_event"), false);

			const withoutNotifications = await seen(true, NATIVE_PLUGINS.filter((plugin) => platform.native.has(plugin) && plugin !== "Notifications"));
			assert.ok(withoutNotifications.toolsets.includes("control"));
			assert.ok(withoutNotifications.offers("sound"));
			assert.equal(withoutNotifications.offers("media"), false);
			assert.ok(!withoutNotifications.toolsets.includes("notifications"));
		},
	],
	[
		"a bot without device_info is told to read the time in codemode, even on a phone that has it",
		async () => {
			const withoutDevice = await seen(true, NATIVE_PLUGINS.filter((plugin) => platform.native.has(plugin)), [], ["device"]);
			assert.equal(withoutDevice.offers("device_info"), false);
			assert.match(withoutDevice.offered, /new Date\(\) in codemode/);
		},
	],
];
