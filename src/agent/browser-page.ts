import { getElementByIndex, PageController, scrollIntoViewIfNeeded } from "@page-agent/page-controller";

const controller = new PageController({ enableMask: false });

function elementAt(index: number): HTMLElement {
	const indexed: unknown = Reflect.get(controller, "selectorMap");
	if (!(indexed instanceof Map)) throw new Error("read the page before acting on an element");
	return getElementByIndex(indexed, index);
}

Object.assign(window, {
	__piPage: {
		state: () => controller.getBrowserState(),
		center: async (index: number) => {
			const element = elementAt(index);
			await scrollIntoViewIfNeeded(element);
			const box = element.getBoundingClientRect();
			return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
		},
		select: (index: number, option: string) => controller.selectOption(index, option),
		scroll: (down: boolean, index?: number) => controller.scroll({ down, numPages: 0.8, ...(index === undefined ? {} : { index }) }),
	},
});
