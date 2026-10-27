import { type Static, Type } from "typebox";
import { Allowed, definePlugin } from "./define.ts";
import { oneOf } from "../agent/parse.ts";

const Step = Type.Object({
	action: oneOf(["tap", "long_press", "swipe", "scroll", "type", "clear", "key", "open", "wait"]),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	to_x: Type.Optional(Type.Number()),
	to_y: Type.Optional(Type.Number()),
	direction: Type.Optional(oneOf(["up", "down", "left", "right"])),
	ms: Type.Optional(Type.Number()),
	text: Type.Optional(Type.String()),
	keys: Type.Optional(Type.String()),
	app: Type.Optional(Type.String()),
});

const Snapshot = Type.Object({
	width: Type.Number(),
	height: Type.Number(),
	package: Type.Optional(Type.String()),
	app: Type.Optional(Type.String()),
	keyboard: Type.Boolean(),
	elements: Type.String(),
	more: Type.Number(),
	jpeg: Type.Optional(Type.String()),
	shotError: Type.Optional(Type.String()),
	slow: Type.Optional(Type.Boolean()),
	done: Type.Optional(Type.Number()),
	error: Type.Optional(Type.String()),
});
export type PhoneScreenSnapshot = Static<typeof Snapshot>;

export const PhoneScreen = definePlugin("PhoneScreen", {
	status: { args: Type.Object({}), result: Allowed },
	openSettings: { args: Type.Object({}) },
	openAppInfo: { args: Type.Object({}) },
	read: { args: Type.Object({ screenshot: Type.Boolean() }), result: Snapshot },
	act: { args: Type.Object({ steps: Type.Array(Step), screenshot: Type.Boolean() }), result: Snapshot },
});
