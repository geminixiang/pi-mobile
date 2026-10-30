import { type Static, Type } from "typebox";
import { definePlugin } from "../plugins/define.ts";
import { oneOf } from "../agent/parse.ts";

export const MAX_TABS = 8;
export const KEYS = ["enter", "tab", "escape", "backspace"] as const;
export const DIRECTIONS = ["down", "up", "left", "right"] as const;

const Index = Type.Integer();
const Direction = oneOf(DIRECTIONS);
const Step = Type.Union([
	Type.Object({ action: Type.Literal("open"), url: Type.String() }),
	Type.Object({ action: Type.Literal("tap"), index: Index }),
	Type.Object({ action: Type.Literal("tap_at"), x: Type.Number(), y: Type.Number() }),
	Type.Object({ action: Type.Literal("type"), index: Index, text: Type.String() }),
	Type.Object({ action: Type.Literal("type_here"), text: Type.String() }),
	Type.Object({ action: Type.Literal("clear") }),
	Type.Object({ action: Type.Literal("select"), index: Index, option: Type.String() }),
	Type.Object({ action: Type.Literal("key"), key: oneOf(KEYS) }),
	Type.Object({ action: Type.Literal("scroll"), direction: Direction }),
	Type.Object({ action: Type.Literal("scroll_in"), index: Index, direction: Direction }),
	Type.Object({ action: oneOf(["back", "forward", "reload"]) }),
	Type.Object({ action: Type.Literal("wait"), ms: Type.Number() }),
	Type.Object({ action: Type.Literal("wait_for"), text: Type.String(), gone: Type.Boolean(), ms: Type.Number() }),
]);
export type BrowserStep = Static<typeof Step>;

const TabItems = Type.Array(Type.Object({ id: Type.String(), url: Type.String(), title: Type.String() }));

const Snapshot = Type.Object({
	tab: Type.String(),
	loading: Type.Boolean(),
	elements: Type.String(),
	tabs: TabItems,
	text: Type.String(),
	jpeg: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	did: Type.Optional(Type.Array(Type.String())),
});
export type BrowserSnapshot = Static<typeof Snapshot>;

const Bot = { bot: Type.String() };
const Tab = { tab: Type.Optional(Type.String()) };
const TabList = Type.Object({ bot: Type.String(), tabs: TabItems, active: Type.Optional(Type.String()) });
export type BrowserTabs = Static<typeof TabList>;

const Page = Type.Object({ ...Bot, tab: Type.String(), url: Type.String(), title: Type.String(), loading: Type.Boolean(), canGoBack: Type.Boolean(), canGoForward: Type.Boolean() });
export type BrowserPage = Static<typeof Page>;

export const Browser = definePlugin(
	"Browser",
	{
		read: { args: Type.Object({ ...Bot, ...Tab, screenshot: Type.Boolean() }), result: Snapshot },
		act: { args: Type.Object({ ...Bot, ...Tab, steps: Type.Array(Step), screenshot: Type.Boolean() }), result: Snapshot },
		go: { args: Type.Object({ ...Bot, ...Tab, action: oneOf(["back", "forward", "reload", "open"]), url: Type.Optional(Type.String()) }) },
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
		page: Page,
		tabs: TabList,
	},
);
