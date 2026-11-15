import { type Static, Type } from "typebox";
import { Capacitor } from "@capacitor/core";
import { Allowed, definePlugin } from "../plugins/define.ts";
import { oneOf } from "../parse.ts";

export const KEYS = ["back", "home", "recents", "notifications", "quick_settings", "enter"] as const;
export function keysFor(platform = Capacitor.getPlatform()): readonly (typeof KEYS)[number][] {
	return platform === "ios" ? KEYS.filter((key) => key !== "recents") : KEYS;
}

export const DIRECTIONS = ["down", "up", "left", "right"] as const;

const Step = Type.Union([
	Type.Object({ action: oneOf(["tap", "long_press"]), x: Type.Number(), y: Type.Number() }),
	Type.Object({ action: Type.Literal("tap"), id: Type.Integer({ minimum: 1 }) }),
	Type.Object({ action: Type.Literal("tap"), text: Type.String() }),
	Type.Object({ action: Type.Literal("wait_for"), text: Type.String(), gone: Type.Boolean(), ms: Type.Integer() }),
	Type.Object({ action: Type.Literal("scroll_to"), text: Type.String(), direction: oneOf(DIRECTIONS) }),
	Type.Object({ action: Type.Literal("expect"), app: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
	Type.Object({ action: Type.Literal("swipe"), x: Type.Number(), y: Type.Number(), to_x: Type.Number(), to_y: Type.Number(), ms: Type.Number() }),
	Type.Object({ action: Type.Literal("scroll"), direction: oneOf(DIRECTIONS), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) }),
	Type.Object({ action: Type.Literal("type"), text: Type.String() }),
	Type.Object({ action: Type.Literal("clear") }),
	Type.Object({ action: Type.Literal("key"), key: oneOf(KEYS) }),
	Type.Object({ action: Type.Literal("open"), app: Type.String() }),
	Type.Object({ action: Type.Literal("wait"), ms: Type.Number() }),
]);
export type PhoneScreenStep = Static<typeof Step>;

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
	did: Type.Optional(Type.Array(Type.String())),
	unchanged: Type.Optional(Type.Boolean()),
	delta: Type.Optional(Type.Boolean()),
	error: Type.Optional(Type.String()),
});
export type PhoneScreenSnapshot = Static<typeof Snapshot>;

export const PhoneScreen = definePlugin("PhoneScreen", {
	status: { args: Type.Object({}), result: Allowed },
	openSettings: { args: Type.Object({}) },
	openAppInfo: { args: Type.Object({}) },
	read: { args: Type.Object({ screenshot: Type.Boolean(), display: Type.Optional(Type.Integer({ minimum: 0 })) }), result: Snapshot },
	act: { args: Type.Object({ steps: Type.Array(Step), screenshot: Type.Boolean(), note: Type.Optional(Type.String()), display: Type.Optional(Type.Integer({ minimum: 0 })) }), result: Snapshot },
});
