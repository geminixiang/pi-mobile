import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";
import { oneOf } from "../agent/parse.ts";

export const BROWSER_ACTIONS = ["open", "tap", "type", "clear", "select", "key", "scroll", "back", "forward", "reload", "wait", "wait_for"] as const;

const Step = Type.Object({
	action: oneOf(BROWSER_ACTIONS),
	url: Type.Optional(Type.String()),
	index: Type.Optional(Type.Integer()),
	option: Type.Optional(Type.String()),
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
	tab: Type.String(),
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
const Tab = { tab: Type.Optional(Type.String()) };
const TabList = Type.Object({ bot: Type.String(), tabs: Type.Array(Type.Object({ id: Type.String(), url: Type.String(), title: Type.String() })), active: Type.Optional(Type.String()) });
export type BrowserTabs = Static<typeof TabList>;

export const Browser = definePlugin(
	"Browser",
	{
		read: { args: Type.Object({ ...Bot, ...Tab, screenshot: Type.Boolean() }), result: Snapshot },
		act: { args: Type.Object({ ...Bot, ...Tab, steps: Type.Array(Step), screenshot: Type.Boolean() }), result: Snapshot },
		newTab: { args: Type.Object(Bot), result: Type.Object({ tab: Type.String() }) },
		selectTab: { args: Type.Object({ ...Bot, tab: Type.String() }) },
		closeTab: { args: Type.Object({ ...Bot, tab: Type.String() }) },
		tabs: { args: Type.Object(Bot), result: TabList },
		show: { args: Type.Object({ ...Bot, x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number(), radius: Type.Number() }) },
		hide: { args: Type.Object(Bot) },
		peek: { args: Type.Object(Bot), result: Type.Object({ jpeg: Type.Optional(Type.String()) }) },
		forget: { args: Type.Object(Bot) },
	},
	{
		page: Type.Object({ ...Bot, tab: Type.String(), active: Type.Boolean(), url: Type.String(), title: Type.String(), loading: Type.Boolean(), canGoBack: Type.Boolean(), canGoForward: Type.Boolean() }),
		tabs: TabList,
	},
);
