const BACK_KEY = "pi-back";

export function backToTop(): boolean {
	const top = [...document.querySelectorAll("[data-back]")].at(-1);
	top?.dispatchEvent(new KeyboardEvent("keydown", { key: BACK_KEY, bubbles: true }));
	return top !== undefined;
}

export function isBack(event: { key: string; target: EventTarget; currentTarget: EventTarget }): boolean {
	return event.key === BACK_KEY && event.target === event.currentTarget;
}
