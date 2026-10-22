// Where a bot's coding tools run: the phone (its folder there), one of the user's computers running pi-host (directly,
// over the tailnet), the sandbox relay's container, or one of the user's machines over SSH, in its container or
// directly as the SSH user. Each bot picks one (Bot.computer); a bot that has
// not picked uses the default from settings › 電腦. Sandboxes open when a bot first uses them and are shared by the
// bots on the same one.
import { EgressLink, type MintedService } from "./sandbox/egress.ts";
import { HostSandbox, parseHosts } from "./sandbox/host.ts";
import { type Machine, parseMachines } from "./sandbox/machine.ts";
import { MachineSandbox, RelaySandbox, type Sandbox, SHARED_SANDBOX } from "./sandbox/sandbox.ts";
import type { Settings } from "../settings.ts";

export const PHONE = "phone";
export const RELAY = "relay";

export interface Computer {
	/** Stored on the bot: "phone", "relay", "host:<host id>", or "<machine id>:container" / "<machine id>:trusted". */
	key: string;
	/** The machine or host, such as "MacBook" or "100.64.0.3". */
	name: string;
	/** How the tools run there: "手機", "容器", "直接". */
	mode: string;
}

function machineKey(machine: Machine, mode: "container" | "trusted"): string {
	return `${machine.id}:${mode}`;
}

/** The mode a machine runs in by its own setting: a container when an engine answers and it is not set to trusted. */
function machineMode(machine: Machine): "container" | "trusted" {
	return machine.system?.engines[0] && machine.mode !== "trusted" ? "container" : "trusted";
}

function relayHost(url: string): string {
	try {
		return new URL(url.replace(/^ws/, "http")).hostname;
	} catch {
		return url;
	}
}

export class Computers {
	readonly #settings: Settings;
	readonly #minted: Record<string, MintedService>;
	readonly #open = new Map<string, Sandbox>();
	#egress: EgressLink | undefined;

	constructor(settings: Settings, minted: Record<string, MintedService>) {
		this.#settings = settings;
		this.#minted = minted;
	}

	/** Every place a bot can work: the phone, the relay when paired, and each connected machine in each mode it has. */
	list(): Computer[] {
		const items: Computer[] = [{ key: PHONE, name: "手機", mode: "手機" }];
		for (const host of parseHosts(this.#settings.hosts)) items.push({ key: `host:${host.id}`, name: host.name, mode: "直接" });
		if (this.#settings.sandboxUrl && this.#settings.sandboxToken) items.push({ key: RELAY, name: relayHost(this.#settings.sandboxUrl), mode: "容器" });
		for (const machine of parseMachines(this.#settings.machines)) {
			if (!machine.system) continue;
			if (machine.system.engines[0]) items.push({ key: machineKey(machine, "container"), name: machine.name, mode: "容器" });
			items.push({ key: machineKey(machine, "trusted"), name: machine.name, mode: "直接" });
		}
		return items;
	}

	/** The default from settings: the chosen computer or machine, else the relay, else the phone. */
	get defaultKey(): string {
		const host = parseHosts(this.#settings.hosts).find((candidate) => candidate.id === this.#settings.sandboxMachine);
		if (host) return `host:${host.id}`;
		const machine = parseMachines(this.#settings.machines).find((candidate) => candidate.id === this.#settings.sandboxMachine);
		if (machine?.system) return machineKey(machine, machineMode(machine));
		if (this.#settings.sandboxUrl && this.#settings.sandboxToken) return RELAY;
		return PHONE;
	}

	/** A bot's choice when it is still there, and otherwise the default. */
	resolve(choice: string | undefined): Computer {
		const items = this.list();
		return items.find((item) => item.key === choice) ?? items.find((item) => item.key === this.defaultKey) ?? items[0]!;
	}

	/** The sandbox for a key, opened on first use; undefined for the phone. */
	sandbox(key: string): Sandbox | undefined {
		if (key === PHONE) return undefined;
		const open = this.#open.get(key);
		if (open) return open;
		let sandbox: Sandbox | undefined;
		if (key.startsWith("host:")) {
			const host = parseHosts(this.#settings.hosts).find((candidate) => `host:${candidate.id}` === key);
			if (!host) return undefined;
			sandbox = new HostSandbox(host);
		} else if (key === RELAY) {
			const { sandboxUrl: url, sandboxToken: token, githubToken } = this.#settings;
			if (!url || !token) return undefined;
			sandbox = new RelaySandbox({ url, token });
			// The relay's proxy asks for the phone's credentials over its control channel.
			this.#egress ??= new EgressLink({
				relayUrl: url,
				relayToken: token,
				githubToken: githubToken || undefined,
				minted: this.#minted,
				describe: (name) => (name === SHARED_SANDBOX ? "共用的 sandbox" : name),
			});
		} else {
			const [id, mode] = key.split(":");
			const machine = parseMachines(this.#settings.machines).find((candidate) => candidate.id === id);
			if (!machine?.system || (mode !== "container" && mode !== "trusted")) return undefined;
			sandbox = new MachineSandbox({ ...machine, mode }, { githubToken: this.#settings.githubToken || undefined, minted: this.#minted });
		}
		this.#open.set(key, sandbox);
		return sandbox;
	}

	/** Whether there is anywhere to work besides the phone. */
	get any(): boolean {
		return this.list().length > 1;
	}

	close(): void {
		this.#egress?.close();
		for (const sandbox of this.#open.values()) sandbox.close();
		this.#open.clear();
	}
}
