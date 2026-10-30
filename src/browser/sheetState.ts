import type { BrowserPage, BrowserTabs } from "./plugin.ts";

export type SheetMode = "closed" | "open" | "auto";

export type SheetInputs = { bot: string | undefined; active: boolean; handover: string | undefined; openKey: number };

export type SheetState = {
	mode: SheetMode;
	strip: boolean;
	shot: string | undefined;
	problem: string;
	pages: Readonly<Record<string, BrowserPage>>;
	tabs: Readonly<Record<string, BrowserTabs>>;
	inputs: SheetInputs;
};

export type SheetEvent =
	| { type: "inputs"; inputs: SheetInputs }
	| { type: "agent_finished" }
	| { type: "settled"; open: boolean }
	| { type: "strip_toggled" }
	| { type: "shot"; jpeg: string }
	| { type: "failed"; message: string }
	| { type: "retried" }
	| { type: "page"; page: BrowserPage }
	| { type: "tabs"; list: BrowserTabs };

export const SHEET_START: SheetState = {
	mode: "closed",
	strip: false,
	shot: undefined,
	problem: "",
	pages: {},
	tabs: {},
	inputs: { bot: undefined, active: false, handover: undefined, openKey: 0 },
};

export const pageKey = (bot: string, tab: string) => `${bot}/${tab}`;

export function sameInputs(a: SheetInputs, b: SheetInputs): boolean {
	return a.bot === b.bot && a.active === b.active && a.handover === b.handover && a.openKey === b.openKey;
}

export function sheetAfter(state: SheetState, event: SheetEvent): SheetState {
	switch (event.type) {
		case "inputs":
			return afterInputs(state, event.inputs);
		case "agent_finished":
			return state.mode === "auto" ? { ...state, mode: "closed" } : state;
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

function afterInputs(state: SheetState, next: SheetInputs): SheetState {
	const before = state.inputs;
	let after = next.bot === before.bot ? state : { ...SHEET_START, pages: state.pages, tabs: state.tabs };
	if (next.active && !before.active) after = { ...after, mode: "auto" };
	if (next.handover !== undefined && next.handover !== before.handover && after.mode === "closed") after = { ...after, mode: "open" };
	if (next.openKey !== before.openKey && next.openKey !== 0 && next.bot !== undefined) after = { ...after, mode: "open" };
	return { ...after, inputs: next };
}
