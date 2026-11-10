import { execFileSync } from "node:child_process";

const PI = "dev.geminixiang.pimobile/";

type Reply = { result?: { value?: unknown; objectId?: string; description?: string }; exceptionDetails?: { exception?: { description?: string } }; wasThrown?: boolean };

const PAGE_HELPERS = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await sleep(100); } return false; };
const button = (label) => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const busy = () => Boolean(button("停止") || button("插話"));
const transcript = () => document.querySelector(".transcript");
const center = (element) => { const r = element.getBoundingClientRect(); return { x: Math.round((r.x + r.width / 2) * devicePixelRatio), y: Math.round((r.y + r.height / 2) * devicePixelRatio) }; };
`;

export class Page {
	#socket: WebSocket;
	#next = 0;
	#pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
	#closed: Error | undefined;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as { id?: number; result?: Reply };
			if (message.id === undefined) return;
			this.#pending.get(message.id)?.resolve(message.result ?? {});
			this.#pending.delete(message.id);
		};
		socket.onclose = () => {
			this.#closed = new Error("The DevTools connection closed: the phone disconnected or pi restarted");
			for (const { reject } of this.#pending.values()) reject(this.#closed);
			this.#pending.clear();
		};
	}

	static async connect(port = process.env.CDP_PORT ?? "9333"): Promise<Page> {
		const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
		const target = targets.find((candidate) => candidate.type === "page" && URL.canParse(candidate.url) && new URL(candidate.url).hostname === "localhost");
		if (!target) throw new Error(`No WebView page on tcp:${port}; run .pi/skills/device-testing/scripts/forward.sh`);
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.onopen = resolve;
			socket.onerror = reject;
		});
		return new Page(socket);
	}

	async eval<T>(body: string): Promise<T> {
		const expression = `(async () => { ${PAGE_HELPERS} ${body} })()`;
		// why: the iPhone's CDP bridge (pymobiledevice3) ignores awaitPromise on evaluate, and reports a throw as wasThrown instead of exceptionDetails
		const started = await this.command("Runtime.evaluate", { expression });
		const settled = started.exceptionDetails || started.wasThrown ? started : await this.command("Runtime.awaitPromise", { promiseObjectId: started.result?.objectId, returnByValue: true });
		if (settled.exceptionDetails) throw new Error(settled.exceptionDetails.exception?.description ?? JSON.stringify(settled.exceptionDetails));
		if (settled.wasThrown) throw new Error(settled.result?.description ?? "the page threw");
		return settled.result?.value as T;
	}

	command(method: string, params: object): Promise<Reply> {
		if (this.#closed) throw this.#closed;
		const id = ++this.#next;
		const reply = new Promise<Reply>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
		this.#socket.send(JSON.stringify({ id, method, params }));
		return reply;
	}

	close() {
		this.#socket.close();
	}
}

export function touches(serial: string) {
	const adbPath = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
	const adb = (...command: string[]) => execFileSync(adbPath, ["-s", serial, "shell", ...command], { encoding: "utf8" });
	const input = (...args: string[]) => {
		const out = adb(`if dumpsys activity activities | grep topResumedActivity | grep -q ${PI}; then input ${args.join(" ")}; else echo NOT_PI; fi`);
		if (out.includes("NOT_PI")) throw new Error(`pi is not in front; stopped before input ${args.join(" ")}`);
	};
	return {
		adb,
		input,
		swipe: (x1: number, y1: number, x2: number, y2: number, ms: number) => input("swipe", String(x1), String(y1), String(x2), String(y2), String(ms)),
		tap: (x: number, y: number) => input("tap", String(x), String(y)),
	};
}
