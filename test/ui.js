// Page-side helpers for test/cdp.ts scripts: React-aware typing and clicking by label.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const button = (label) =>
	[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const click = (label) => {
	const target = button(label);
	if (!target) throw new Error(`no button ${label}`);
	target.click();
};
const type = (text) => {
	const area = document.querySelector(".composer textarea");
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, text);
	area.dispatchEvent(new Event("input", { bubbles: true }));
};
const until = async (predicate, ms = 60000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (predicate()) return true;
		await sleep(100);
	}
	return false;
};
const busy = () => Boolean(button("停止") || button("插話"));
const messages = () => [...document.querySelectorAll(".prompt, .answer, .trace-row, .divider")].map((e) => `${e.className}: ${e.textContent.replace(/\s+/g, " ").slice(0, 90)}`);
