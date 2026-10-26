import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";
import { oneOf } from "../agent/tools/common.ts";

export const CALL_KINDS = ["incoming", "outgoing", "missed", "rejected", "blocked", "voicemail", "other"] as const;

const CallRecord = Type.Object({
	number: Type.String(),
	name: Type.Optional(Type.String()),
	type: oneOf(CALL_KINDS),
	time: Type.Number(),
	seconds: Type.Number(),
});
export type CallRecord = Static<typeof CallRecord>;

const SmsRecord = Type.Object({
	address: Type.String(),
	name: Type.Optional(Type.String()),
	text: Type.String(),
	time: Type.Number(),
	sent: Type.Boolean(),
	read: Type.Boolean(),
});

export const Records = definePlugin("Records", {
	calls: { args: Type.Object({ since: Type.Number(), limit: Type.Optional(Type.Integer()) }), result: Type.Object({ items: Type.Array(CallRecord) }) },
	sms: {
		args: Type.Object({ since: Type.Number(), limit: Type.Optional(Type.Integer()), query: Type.Optional(Type.String()) }),
		result: Type.Object({ items: Type.Array(SmsRecord) }),
	},
});
