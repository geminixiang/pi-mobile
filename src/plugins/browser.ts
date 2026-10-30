import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";
import { oneOf } from "../agent/parse.ts";

export const BROWSER_ACTIONS = ["open", "tap", "type", "clear", "key", "scroll", "back", "wait", "wait_for"] as const;

const Step = Type.Object({
	action: oneOf(BROWSER_ACTIONS),
	url: Type.Optional(Type.String()),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	text: Type.Optional(Type.String()),
	gone: Type.Optional(Type.Boolean()),
	keys: Type.Optional(Type.String()),
	direction: Type.Optional(oneOf(["up", "down", "left", "right"])),
	ms: Type.Optional(Type.Number()),
});
export type BrowserStep = Static<typeof Step>;

const Snapshot = Type.Object({
	url: Type.String(),
	title: Type.String(),
	width: Type.Number(),
	height: Type.Number(),
	scrollY: Type.Number(),
	scrollHeight: Type.Number(),
	loading: Type.Boolean(),
	elements: Type.String(),
	more: Type.Number(),
	text: Type.String(),
	jpeg: Type.Optional(Type.String()),
	done: Type.Optional(Type.Number()),
	error: Type.Optional(Type.String()),
});
export type BrowserSnapshot = Static<typeof Snapshot>;

const Bot = { bot: Type.String() };

export const Browser = definePlugin("Browser", {
	read: { args: Type.Object({ ...Bot, screenshot: Type.Boolean() }), result: Snapshot },
	act: { args: Type.Object({ ...Bot, steps: Type.Array(Step), screenshot: Type.Boolean() }), result: Snapshot },
	show: { args: Type.Object({ ...Bot, x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() }) },
	hide: { args: Type.Object(Bot) },
	forget: { args: Type.Object(Bot) },
});
