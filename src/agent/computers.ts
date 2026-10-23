// Where a bot's coding tools run: the phone (its folder there), or one of the user's computers running pi-host,
// directly or in its container (sandbox/host.ts). Each bot picks one (Bot.computer); a bot that has not picked uses the
// default from settings › 電腦. Sandboxes open when a bot first uses them and are shared by the bots on the same one.
import type { MintedService } from "./sandbox/container.ts";
import { type Host, type HostMode, HostSandbox, parseHosts } from "./sandbox/host.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import type { Settings } from "../settings.ts";

export const PHONE = "phone";

export interface Computer {
	/** Stored on the bot: "phone", or "<host id>:direct" / "<host id>:container". */
	key: string;
	/** The computer's name, such as "MacBook". */
	name: string;
	/** How the tools run there: "手機", "直接", "容器". */
	mode: string;
}

const MODE_LABEL: Record<HostMode, string> = { direct: "直接", container: "容器" };

function parseKey(key: string): { id: string; mode: HostMode } | undefined {
	const [id, mode] = key.split(":");
	return id && (mode === "direct" || mode === "container") ? { id, mode } : undefined;
}

export class Computers {
	readonly #settings: Settings;
	readonly #minted: Record<string, MintedService>;
	readonly #open = new Map<string, Sandbox>();

	constructor(settings: Settings, minted: Record<string, MintedService>) {
		this.#settings = settings;
		this.#minted = minted;
	}

	/** Every place a bot can work: the phone, and each computer directly and, with a container engine, in its container. */
	list(): Computer[] {
		const items: Computer[] = [{ key: PHONE, name: "手機", mode: "手機" }];
		for (const host of parseHosts(this.#settings.hosts)) {
			items.push({ key: `${host.id}:direct`, name: host.name, mode: MODE_LABEL.direct });
			if (host.engine) items.push({ key: `${host.id}:container`, name: host.name, mode: MODE_LABEL.container });
		}
		return items;
	}

	/** The computer behind a key; undefined for the phone. */
	host(key: string): Host | undefined {
		const parsed = parseKey(key);
		return parsed && parseHosts(this.#settings.hosts).find((candidate) => candidate.id === parsed.id);
	}

	/** The default from settings, else the phone. */
	get defaultKey(): string {
		return this.list().some((item) => item.key === this.#settings.computer) ? this.#settings.computer : PHONE;
	}

	/** A bot's choice when it is still there, and otherwise the default. */
	resolve(choice: string | undefined): Computer {
		const items = this.list();
		return items.find((item) => item.key === choice) ?? items.find((item) => item.key === this.defaultKey) ?? items[0]!;
	}

	/** The sandbox for a key, opened on first use; undefined for the phone. */
	sandbox(key: string): Sandbox | undefined {
		const open = this.#open.get(key);
		if (open) return open;
		const parsed = parseKey(key);
		const host = this.host(key);
		if (!parsed || !host) return undefined;
		const sandbox = new HostSandbox(host, parsed.mode, { githubToken: this.#settings.githubToken || undefined, minted: this.#minted });
		this.#open.set(key, sandbox);
		return sandbox;
	}

	/** Whether there is anywhere to work besides the phone. */
	get any(): boolean {
		return this.list().length > 1;
	}

	close(): void {
		for (const sandbox of this.#open.values()) sandbox.close();
		this.#open.clear();
	}
}
