import type { BrowserPage, BrowserTabs } from "./plugin.ts";

export type SheetMode = "closed" | "open" | "handover";

export type SheetInputs = { bot: string | undefined; handover: string | undefined; asking: boolean; openKey: number };

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
	inputs: { bot: undefined, handover: undefined, asking: false, openKey: 0 },
};

export const pageKey = (bot: string, tab: string) => `${bot}/${tab}`;

export function sameInputs(a: SheetInputs, b: SheetInputs): boolean {
	return a.bot === b.bot && a.handover === b.handover && a.asking === b.asking && a.openKey === b.openKey;
}

export function sheetAfter(state: SheetState, event: SheetEvent): SheetState {
	switch (event.type) {
		case "inputs":
			return afterInputs(state, event.inputs);
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
	if (next.handover !== undefined && next.handover !== before.handover && after.mode === "closed") after = { ...after, mode: "handover" };
	if (next.handover === undefined && after.mode === "handover") after = { ...after, mode: "closed" };
	if (next.asking && !before.asking) after = { ...after, mode: "closed" };
	if (next.openKey !== before.openKey && next.openKey !== 0 && next.bot !== undefined) after = { ...after, mode: "open" };
	return { ...after, inputs: next };
}
