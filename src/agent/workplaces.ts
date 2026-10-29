import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MintedService } from "./sandbox/container.ts";
import { computerKey, type HostMode, HostSandbox, type PairedHost, pairedHosts } from "./sandbox/host.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import type { Settings } from "../settings.ts";
import type { FolderNetwork } from "./files/folder-network.ts";
import type { PhoneApp } from "./platform.ts";

const PHONE = "phone";

export interface Computer {
	key: string;
	name: string;
	mode: string;
}

export type Workplace =
	| { kind: "phone"; folder: string; env(): ExecutionEnv }
	| { kind: "computer"; folder: string; computer: Computer; host: PairedHost; sandbox: Sandbox; root: string; env(): Promise<ExecutionEnv> }
	| { kind: "missing"; key: string };

export type Placed = { folder: string; computer?: string };

const MODE_LABEL: Record<HostMode, string> = { direct: "直接", container: "容器" };

type Entry = { computer: Computer; host: PairedHost; mode: HostMode };

export class Workplaces {
	#settings: Settings;
	#hosts: PairedHost[];
	readonly #minted: Record<string, MintedService>;
	readonly #phone: PhoneApp | undefined;
	readonly #placed: (id: string) => Placed | undefined;
	readonly #open = new Map<string, Sandbox>();

	constructor(settings: Settings, minted: Record<string, MintedService>, phone: PhoneApp | undefined, placed: (id: string) => Placed | undefined) {
		this.#settings = settings;
		this.#hosts = pairedHosts(settings);
		this.#minted = minted;
		this.#phone = phone;
		this.#placed = placed;
	}

	apply(settings: Settings): void {
		const previous = this.#hosts;
		this.#settings = settings;
		this.#hosts = pairedHosts(settings).map((host) => previous.find((known) => JSON.stringify(known) === JSON.stringify(host)) ?? host);
		const entries = this.#entries();
		for (const [key, sandbox] of this.#open) {
			const entry = entries.find((candidate) => candidate.computer.key === key);
			if (entry && previous.includes(entry.host)) continue;
			sandbox.close();
			this.#open.delete(key);
		}
	}

	#entries(): Entry[] {
		return this.#hosts.flatMap((host) => {
			const modes: HostMode[] = host.engine ? ["direct", "container"] : ["direct"];
			return modes.map((mode) => ({ computer: { key: computerKey(host.id, mode), name: host.name, mode: MODE_LABEL[mode] }, host, mode }));
		});
	}

	list(): Computer[] {
		const computers = this.#entries().map((entry) => entry.computer);
		return this.#phone ? [{ key: PHONE, name: "手機", mode: "手機" }, ...computers] : computers;
	}

	get any(): boolean {
		return this.list().length > 1;
	}

	at(id: string): Workplace | undefined {
		const placed = this.#placed(id);
		if (!placed) return undefined;
		const { folder, computer: choice } = placed;
		const key = choice || (this.list().some((item) => item.key === this.#settings.computer) ? this.#settings.computer : PHONE);
		const phone = this.#phone;
		if (key === PHONE && phone) return { kind: "phone", folder, env: () => phone.folder(folder, this.network) };
		const entry = this.#entries().find((candidate) => candidate.computer.key === key);
		if (!entry) return { kind: "missing", key };
		const sandbox = this.#sandbox(entry);
		return { kind: "computer", folder, computer: entry.computer, host: entry.host, sandbox, root: sandbox.root(folder), env: () => sandbox.env(folder) };
	}

	get network(): FolderNetwork {
		return { githubToken: this.#settings.githubToken || undefined };
	}

	offers(id: string): boolean {
		return this.any || this.at(id)?.kind === "missing";
	}

	containers(): { key: string; sandbox: Sandbox }[] {
		return this.#entries()
			.filter((entry) => entry.mode === "container")
			.map((entry) => ({ key: entry.computer.key, sandbox: this.#sandbox(entry) }));
	}

	#sandbox({ computer, host, mode }: Entry): Sandbox {
		const open = this.#open.get(computer.key);
		if (open) return open;
		const sandbox = new HostSandbox(host, mode, { ...this.network, minted: this.#minted });
		this.#open.set(computer.key, sandbox);
		return sandbox;
	}

	close(): void {
		for (const sandbox of this.#open.values()) sandbox.close();
		this.#open.clear();
	}
}
