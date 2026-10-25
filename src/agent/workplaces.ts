import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MintedService } from "./sandbox/container.ts";
import { type Host, type HostMode, HostSandbox, parseHosts } from "./sandbox/host.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import type { Settings } from "../settings.ts";
import type { FolderNetwork } from "./files/folder-network.ts";

const PHONE = "phone";

export interface Computer {
	key: string;
	name: string;
	mode: string;
}

export type Workplace =
	| { kind: "phone"; folder: string; env(): ExecutionEnv }
	| { kind: "computer"; folder: string; computer: Computer; host: Host; sandbox: Sandbox; root: string; env(): Promise<ExecutionEnv> }
	| { kind: "missing"; key: string };

export type Placed = { folder: string; computer?: string };

const MODE_LABEL: Record<HostMode, string> = { direct: "直接", container: "容器" };

function parseKey(key: string): { id: string; mode: HostMode } | undefined {
	const [id, mode] = key.split(":");
	return id && (mode === "direct" || mode === "container") ? { id, mode } : undefined;
}

export class Workplaces {
	readonly #settings: Settings;
	readonly #hosts: Host[];
	readonly #minted: Record<string, MintedService>;
	readonly #phoneFolder: (folder: string, network: FolderNetwork) => ExecutionEnv;
	readonly #placed: (id: string) => Placed | undefined;
	readonly #open = new Map<string, Sandbox>();

	constructor(settings: Settings, minted: Record<string, MintedService>, phoneFolder: (folder: string, network: FolderNetwork) => ExecutionEnv, placed: (id: string) => Placed | undefined) {
		this.#settings = settings;
		this.#hosts = parseHosts(settings.hosts);
		this.#minted = minted;
		this.#phoneFolder = phoneFolder;
		this.#placed = placed;
	}

	list(): Computer[] {
		const items: Computer[] = [{ key: PHONE, name: "手機", mode: "手機" }];
		for (const host of this.#hosts) {
			items.push({ key: `${host.id}:direct`, name: host.name, mode: MODE_LABEL.direct });
			if (host.engine) items.push({ key: `${host.id}:container`, name: host.name, mode: MODE_LABEL.container });
		}
		return items;
	}

	get any(): boolean {
		return this.list().length > 1;
	}

	at(id: string): Workplace | undefined {
		const placed = this.#placed(id);
		if (!placed) return undefined;
		return this.resolve(placed);
	}

	resolve({ folder, computer: choice }: Placed): Workplace {
		const items = this.list();
		const key = choice || (items.some((item) => item.key === this.#settings.computer) ? this.#settings.computer : PHONE);
		const computer = items.find((item) => item.key === key);
		if (!computer) return { kind: "missing", key };
		if (key === PHONE) return { kind: "phone", folder, env: () => this.#phoneFolder(folder, this.network) };
		const parsed = parseKey(key);
		const host = parsed && this.#hosts.find((candidate) => candidate.id === parsed.id);
		if (!parsed || !host) return { kind: "missing", key };
		const sandbox = this.#sandbox(key, host, parsed.mode);
		return { kind: "computer", folder, computer, host, sandbox, root: sandbox.root(folder), env: () => sandbox.env(folder) };
	}

	get network(): FolderNetwork {
		return { githubToken: this.#settings.githubToken || undefined };
	}

	offers(id: string): boolean {
		return this.any || this.at(id)?.kind === "missing";
	}

	containers(): { key: string; sandbox: Sandbox }[] {
		return this.list().flatMap((computer) => {
			const parsed = parseKey(computer.key);
			const host = parsed && this.#hosts.find((candidate) => candidate.id === parsed.id);
			return parsed?.mode === "container" && host ? [{ key: computer.key, sandbox: this.#sandbox(computer.key, host, parsed.mode) }] : [];
		});
	}

	#sandbox(key: string, host: Host, mode: HostMode): Sandbox {
		const open = this.#open.get(key);
		if (open) return open;
		const sandbox = new HostSandbox(host, mode, { githubToken: this.#settings.githubToken || undefined, minted: this.#minted });
		this.#open.set(key, sandbox);
		return sandbox;
	}

	close(): void {
		for (const sandbox of this.#open.values()) sandbox.close();
		this.#open.clear();
	}
}
