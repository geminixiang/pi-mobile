import type { BrowserPage, BrowserTabs } from "./plugin.ts";

export type SheetMode = "closed" | "open" | "auto";

export type SheetState = {
	mode: SheetMode;
	strip: boolean;
	shot: string | undefined;
	problem: string;
	pages: Readonly<Record<string, BrowserPage>>;
	tabs: Readonly<Record<string, BrowserTabs>>;
};

export type SheetEvent =
	| { type: "bot_changed" }
	| { type: "agent_started" }
	| { type: "agent_finished" }
	| { type: "handover" }
	| { type: "user_opened" }
	| { type: "settled"; open: boolean }
	| { type: "strip_toggled" }
	| { type: "shot"; jpeg: string }
	| { type: "failed"; message: string }
	| { type: "retried" }
	| { type: "page"; page: BrowserPage }
	| { type: "tabs"; list: BrowserTabs };

export const SHEET_START: SheetState = { mode: "closed", strip: false, shot: undefined, problem: "", pages: {}, tabs: {} };

export const pageKey = (bot: string, tab: string) => `${bot}/${tab}`;

export function sheetAfter(state: SheetState, event: SheetEvent): SheetState {
	switch (event.type) {
		case "bot_changed":
			return { ...SHEET_START, pages: state.pages, tabs: state.tabs };
		case "agent_started":
			return { ...state, mode: "auto" };
		case "agent_finished":
			return state.mode === "auto" ? { ...state, mode: "closed" } : state;
		case "handover":
			return state.mode === "closed" ? { ...state, mode: "open" } : state;
		case "user_opened":
			return { ...state, mode: "open" };
		case "settled":
			return { ...state, mode: event.open ? "open" : "closed" };
		case "strip_toggled":
			return { ...state, strip: !state.strip };
		case "shot":
			return { ...state, shot: event.jpeg };
		case "failed":
			return { ...state, problem: event.message };
		case "retried":
			return { ...state, problem: "" };
		case "page":
			return { ...state, pages: { ...state.pages, [pageKey(event.page.bot, event.page.tab)]: event.page } };
		case "tabs":
			return { ...state, tabs: { ...state.tabs, [event.list.bot]: event.list } };
	}
}
