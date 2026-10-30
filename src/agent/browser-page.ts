import { getElementByIndex, PageController, scrollIntoViewIfNeeded } from "@page-agent/page-controller";

const controller = new PageController({ enableMask: false });
const SCROLL_PAGES = 0.8;

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
		state: () => controller.getBrowserState(),
		center: async (index: number) => {
			const element = elementAt(index);
			await scrollIntoViewIfNeeded(element);
			const box = element.getBoundingClientRect();
			if (box.width === 0 && box.height === 0) throw new Error(`[${index}] is not visible; read the page again`);
			return { x: (box.left + box.width / 2) * devicePixelRatio, y: (box.top + box.height / 2) * devicePixelRatio };
		},
		select: (index: number, option: string) => settled(controller.selectOption(index, option)),
		scroll: (direction: Direction, index?: number) => {
			const at = index === undefined ? {} : { index };
			if (direction === "up" || direction === "down") return settled(controller.scroll({ down: direction === "down", numPages: SCROLL_PAGES, ...at }));
			return settled(controller.scrollHorizontally({ right: direction === "right", pixels: Math.round(innerWidth * SCROLL_PAGES), ...at }));
		},
	},
});
