import { getElementByIndex, PageController, scrollIntoViewIfNeeded } from "@page-agent/page-controller";

const controller = new PageController({ enableMask: false });
const SCROLL_PAGES = 0.8;
const OWNER_CHARS = 60;
const LABEL_CHARS = 40;
const ELEMENT_LINE = /^\t*\*?\[(\d+)\](<.*)$/;

type Direction = "up" | "down" | "left" | "right";

function elementAt(index: number): HTMLElement {
	const indexed: unknown = Reflect.get(controller, "selectorMap");
	if (!(indexed instanceof Map)) throw new Error("read the page before acting on an element");
	const element = getElementByIndex(indexed, index);
	if (!element.isConnected) throw new Error(`[${index}] is gone from the page; read the page again, since its [n] indexes change when the page does`);
	return element;
}

async function settled<T extends { success: boolean; message: string }>(result: Promise<T>): Promise<T> {
	const outcome = await result;
	if (!outcome.success) throw new Error(outcome.message);
	return outcome;
}

Object.assign(window, {
	__piPage: {
		state: async () => {
			const state = await controller.getBrowserState();
			await controller.cleanUpHighlights();
			return { ...state, content: withOwners(state.content) };
		},
		center: async (index: number) => {
			const element = elementAt(index);
			await scrollIntoViewIfNeeded(element);
			const box = element.getBoundingClientRect();
			if (box.width === 0 && box.height === 0) throw new Error(`[${index}] is not visible; read the page again`);
			return { x: (box.left + box.width / 2) * devicePixelRatio, y: (box.top + box.height / 2) * devicePixelRatio, what: described(element) };
		},
		select: (index: number, option: string) => settled(controller.selectOption(index, option)),
		scroll: async (direction: Direction, index?: number) => {
			if (index === undefined && Reflect.get(controller, "isIndexed") !== true) {
				await controller.updateTree();
				await controller.cleanUpHighlights();
			}
			const at = index === undefined ? {} : { index };
			if (direction === "up" || direction === "down") return settled(controller.scroll({ down: direction === "down", numPages: SCROLL_PAGES, ...at }));
			return settled(controller.scrollHorizontally({ right: direction === "right", pixels: Math.round(innerWidth * SCROLL_PAGES), ...at }));
		},
	},
});

function withOwners(content: string): string {
	const lines = content.split("\n");
	const found = lines.map((line) => ELEMENT_LINE.exec(line));
	const counts = new Map<string, number>();
	for (const match of found) if (match) counts.set(match[2], (counts.get(match[2]) ?? 0) + 1);
	return lines
		.map((line, at) => {
			const match = found[at];
			if (!match || (counts.get(match[2]) ?? 0) < 2) return line;
			const owner = ownerOf(elementAt(Number(match[1])));
			return owner ? `${line} in ${quoted(owner)}` : line;
		})
		.join("\n");
}

function ownerOf(element: HTMLElement): string {
	const own = element.innerText.trim();
	for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
		const rest = node.innerText.replace(own, "").replace(/\s+/g, " ").trim();
		if (!/[\p{L}\p{N}]/u.test(rest)) continue;
		return rest.length > OWNER_CHARS ? "" : rest;
	}
	return "";
}

function described(element: HTMLElement): string {
	const label = (element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder") || element.title).replace(/\s+/g, " ").trim().slice(0, LABEL_CHARS);
	const owner = ownerOf(element);
	return owner ? `${label} in ${quoted(owner)}` : label;
}

function quoted(text: string): string {
	return `"${text.replaceAll('"', "'")}"`;
}
