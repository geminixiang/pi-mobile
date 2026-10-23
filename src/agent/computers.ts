import type { MintedService } from "./sandbox/container.ts";
import { type Host, type HostMode, HostSandbox, parseHosts } from "./sandbox/host.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import type { Settings } from "../settings.ts";

const PHONE = "phone";

export interface Computer {
	key: string;
	name: string;
	mode: string;
}

export type Placement = { kind: "ready"; computer: Computer } | { kind: "missing"; key: string };

export const MISSING_COMPUTER = "這個 Bot 選的電腦已經從設定移除，請在 Bot 面板重新選一台電腦";

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

	list(): Computer[] {
		const items: Computer[] = [{ key: PHONE, name: "手機", mode: "手機" }];
		for (const host of parseHosts(this.#settings.hosts)) {
			items.push({ key: `${host.id}:direct`, name: host.name, mode: MODE_LABEL.direct });
			if (host.engine) items.push({ key: `${host.id}:container`, name: host.name, mode: MODE_LABEL.container });
		}
		return items;
	}

	host(key: string): Host | undefined {
		const parsed = parseKey(key);
		return parsed && parseHosts(this.#settings.hosts).find((candidate) => candidate.id === parsed.id);
	}

	get defaultKey(): string {
		return this.list().some((item) => item.key === this.#settings.computer) ? this.#settings.computer : PHONE;
	}

	resolve(choice: string | undefined): Placement {
		const items = this.list();
		const key = choice || this.defaultKey;
		const computer = items.find((item) => item.key === key);
		return computer ? { kind: "ready", computer } : { kind: "missing", key };
	}

	sandboxAt(placement: Placement): Sandbox | undefined {
		return placement.kind === "ready" ? this.sandbox(placement.computer.key) : undefined;
	}

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

	get any(): boolean {
		return this.list().length > 1;
	}

	close(): void {
		for (const sandbox of this.#open.values()) sandbox.close();
		this.#open.clear();
	}
}
