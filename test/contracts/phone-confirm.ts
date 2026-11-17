import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createJudge, type Judge } from "../../src/agent/judge.ts";
import { APPROVE, blank, judgePress, marked, type Outside, said } from "../../src/agent/outside.ts";
import { firstWaiting, remember, seenOn } from "../../src/phone-screen/confirm.ts";
import type { PhoneScreenSnapshot, PhoneScreenStep } from "../../src/phone-screen/plugin.ts";
import { type Check, faux, platform, settings } from "./setup.ts";

const TOOL = "phone_act_as_user";
const CHAT = 41;
const screen = (elements: string, delta = false): PhoneScreenSnapshot => ({ width: 540, height: 1200, keyboard: true, elements, more: 0, delta, app: "Chat" });
const chat = '[3] button "Send" at 500,1100\n[4] field "see you at seven" at 250,1100 focused\n[5] button "Back" at 30,60';
const sendJudge = (asked: string[] = []): Judge => ({
	ask: async (_questions, state) => {
		asked.push(String(state.control));
		return { kind: "answered", probabilities: { sends: String(state.control).includes("Send") || String(state.control).includes("Enter") ? 0.95 : 0.05, spelled: 0.1 }, model: "fixture" };
	},
});
const check = (doc: Outside, judge: Judge, list: PhoneScreenStep[]) => firstWaiting(doc, TOOL, seenOn(CHAT), list, (control) => judgePress(judge, doc.said, { app: "Chat", keyboard: true }, control));
const steps: PhoneScreenStep[] = [{ action: "tap", id: 5 }, { action: "type", text: "ok" }, { action: "tap", id: 3 }];

export const checks: Check[] = [
	[
		"a tap that sends what the user did not spell out waits for them, and only the steps before it run",
		async () => {
			remember(CHAT, screen(chat));
			const asked: string[] = [];
			const { waits, choices } = await check(said(blank(), "回她"), sendJudge(asked), steps);
			assert.equal(waits?.at, 2);
			assert.match(waits?.reason ?? "", /In Chat, pressing button "Send"/);
			assert.match(waits?.reason ?? "", new RegExp(APPROVE));
			assert.deepEqual(asked.sort(), ['button "Back"', 'button "Send" (earlier in these steps it typed "ok")'], "only presses are judged, by what they press");
			assert.equal(choices.length, 2);
		},
	],
	[
		"Enter in a focused field and a tap by point are judged by the element they reach",
		async () => {
			remember(CHAT, screen(chat));
			const enter = await check(said(blank(), "回她"), sendJudge(), [{ action: "key", key: "enter" }]);
			assert.match(enter.waits?.reason ?? "", /the Enter key in field "see you at seven"/);
			const point = await check(said(blank(), "回她"), sendJudge(), [{ action: "tap", x: 498, y: 1096 }]);
			assert.equal(point.waits?.at, 0);
		},
	],
	[
		"Enter after tapping and typing into a field is judged by that field and the text typed, even before the field had focus",
		async () => {
			remember(CHAT, screen('[7] field empty hint="Search or type URL" at 231,265\n[8] button "New tab" at 400,265'));
			const asked: string[] = [];
			await check(said(blank(), "open example.org"), sendJudge(asked), [{ action: "tap", id: 7 }, { action: "type", text: "https://example.org" }, { action: "key", key: "enter" }]);
			assert.deepEqual(asked, ['the Enter key in field empty hint="Search or type URL" (earlier in these steps it typed "https://example.org")'], "a tap into a field only moves the cursor, so it is not judged");
			const typed: string[] = [];
			await check(said(blank(), "open example.org"), sendJudge(typed), [{ action: "type", id: 7, text: "https://example.org" }, { action: "key", key: "enter" }]);
			assert.deepEqual(typed, ['the Enter key in field empty hint="Search or type URL" (earlier in these steps it typed "https://example.org")'], "typing into a field by id is not judged, and Enter is judged in that field");
		},
	],
	[
		"the user's 送出這次 lets that press run once, on their next turn",
		async () => {
			remember(CHAT, screen(chat));
			const first = await check(said(blank(), "回她"), sendJudge(), steps);
			const held = first.choices.reduce((doc, choice) => (choice.mark ? marked(doc, choice.mark) : doc), said(blank(), "回她"));
			const again = await check(held, sendJudge(), [{ action: "tap", id: 3 }]);
			assert.match(again.waits?.reason ?? "", /already asked/, "the same turn waits for the answer");
			const yes = said(held, APPROVE);
			const run = await check(yes, sendJudge(), [{ action: "tap", id: 3 }]);
			assert.equal(run.waits, undefined);
			const used = run.choices.reduce((doc, choice) => (choice.mark ? marked(doc, choice.mark) : doc), yes);
			assert.notEqual((await check(used, sendJudge(), [{ action: "tap", id: 3 }])).waits, undefined, "used once");
		},
	],
	[
		"a send the user spelled out runs; with no judge at all it waits",
		async () => {
			remember(CHAT, screen(chat));
			const spelled: Judge = { ask: async () => ({ kind: "answered", probabilities: { sends: 0.95, spelled: 0.9 }, model: "fixture" }) };
			assert.equal((await check(said(blank(), "回她「好，七點見」"), spelled, steps)).waits, undefined);
			const none: Judge = { ask: async () => ({ kind: "unavailable" }) };
			assert.equal((await check(said(blank(), "回她"), none, steps)).waits?.at, 0);
		},
	],
	[
		"a changed screen updates what an id presses; an id that left the screen is judged by its number",
		async () => {
			remember(CHAT, screen(chat));
			remember(CHAT, screen('[6] button "Next" at 270,900\ngone: [3]', true));
			const asked: string[] = [];
			await check(blank(), sendJudge(asked), [{ action: "tap", id: 3 }, { action: "tap", id: 5 }, { action: "tap", id: 6 }]);
			assert.deepEqual(asked, ["element [3]", 'button "Back"', 'button "Next"']);
		},
	],
	[
		"with no classifier the bot's own model answers the same questions",
		async () => {
			const { models } = await platform.models(settings, () => settings.compactAt);
			faux.setResponses([() => fauxAssistantMessage('```json\n{"sends": true, "spelled": false}\n```')]);
			const verdict = await createJudge(models, faux.models[0]).ask({ sends: { instructions: "?", yes: "y", no: "n" }, spelled: { instructions: "?", yes: "y", no: "n" } }, { control: "Send" });
			assert.deepEqual(verdict.kind === "answered" ? verdict.probabilities : verdict, { sends: 1, spelled: 0 });
			faux.setResponses([() => fauxAssistantMessage("yes")]);
			assert.equal((await createJudge(models, faux.models[0]).ask({ sends: { instructions: "?", yes: "y", no: "n" } }, {})).kind, "failed");
		},
	],
];
