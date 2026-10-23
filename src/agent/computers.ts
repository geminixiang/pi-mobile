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

	resolve(choice: string | undefined): Computer {
		const items = this.list();
		return items.find((item) => item.key === choice) ?? items.find((item) => item.key === this.defaultKey) ?? items[0]!;
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
