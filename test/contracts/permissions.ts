import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { FormAnswer } from "../../src/agent/mcp-stateless.ts";
import type { PendingForm } from "../../src/interaction/forms.ts";
import { type PermissionState, permissionGate } from "../../src/interaction/permissions.ts";
import type { Check } from "./setup.ts";

// why: the gate reads only callId and conversationId from its api; a whole Harness is not what these checks are about
const api = { callId: "call-1/1", conversationId: "bot-1" } as unknown as ToolExecutionApi;

const ACCEPTED: FormAnswer = { action: "accept", content: {} };

function fixture(state: PermissionState, { answer = ACCEPTED, granted = true }: { answer?: FormAnswer; granted?: boolean } = {}) {
	const asked: PendingForm[] = [];
	const requests: string[] = [];
	const gate = permissionGate(
		{ state: async () => state, request: async (kind) => (requests.push(kind), granted) },
		async (_callId, form) => (asked.push(form), answer),
	);
	return { asked, requests, pass: () => gate("contacts", api, BACKGROUND_CONTEXT) };
}

export const checks: Check[] = [
	[
		"a permission already granted, or one this platform does not report, asks nothing",
		async () => {
			for (const state of ["granted", "unknown"] as const) {
				const { asked, requests, pass } = fixture(state);
				await pass();
				assert.deepEqual([asked.length, requests.length], [0, 0]);
			}
		},
	],
	[
		"a missing permission shows a card first, and only the user's tap brings up the system dialog",
		async () => {
			const { asked, requests, pass } = fixture("ask");
			await pass();
			assert.equal(asked[0]?.service, "聯絡人");
			assert.equal(asked[0]?.confirm, "允許");
			assert.deepEqual(requests, ["contacts"]);
		},
	],
	[
		"declining the card asks the system nothing and tells the bot to go on without it",
		async () => {
			const { requests, pass } = fixture("ask", { answer: { action: "decline" } });
			await assert.rejects(pass(), /did not allow contacts/);
			assert.equal(requests.length, 0);
		},
	],
	[
		"saying no in the system dialog also tells the bot",
		async () => {
			await assert.rejects(fixture("ask", { granted: false }).pass(), /did not allow contacts/);
		},
	],
	[
		"a permission the system will not ask for again points to the phone's settings",
		async () => {
			const { asked, pass } = fixture("denied");
			await assert.rejects(pass(), /設定 › 應用程式 › pi › 權限/);
			assert.equal(asked.length, 0);
		},
	],
	[
		"a card nobody answered asks the system nothing and tells the bot so",
		async () => {
			const { requests, pass } = fixture("ask", { answer: { action: "cancel" } });
			await assert.rejects(pass(), /Nobody answered the request for contacts/);
			assert.equal(requests.length, 0);
		},
	],
	[
		"two tools needing the same permission at once show one card",
		async () => {
			const { asked, pass } = fixture("ask");
			await Promise.all([pass(), pass()]);
			assert.equal(asked.length, 1);
		},
	],
];
