// One of the user's computers running pi-host (host/main.go), reached over the tailnet: no SSH, no key, no password.
// pi-host accepts only devices of the same Tailscale user, so the tailnet is the authentication. The phone brings the
// pi-env daemon: it asks what the computer has (/info), uploads the daemon for its system when missing, and opens a
// WebSocket per connection that pi-host turns into `pi-env serve` in a login shell from home
// (docs/design/computer-host.md). The bot operates the computer directly, as the user who runs pi-host.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { log } from "../../log.ts";
import { daemon } from "./machine.ts";
import { directDescription, type Sandbox, SharedEnvs } from "./sandbox.ts";
import { lost, StreamConnection } from "./stream-connection.ts";

export const HOST_PORT = 4790;

const HostInfo = Type.Object({
	version: Type.String(),
	os: Type.Union([Type.Literal("darwin"), Type.Literal("linux")]),
	arch: Type.Union([Type.Literal("x64"), Type.Literal("arm64")]),
	user: Type.String(),
	home: Type.String(),
	name: Type.String(),
	dnsName: Type.String(),
	daemons: Type.Array(Type.String()),
});
export type HostInfo = Static<typeof HostInfo>;

const Host = Type.Object({
	id: Type.String(),
	/** What the user calls it: the computer's own name. */
	name: Type.String(),
	/** Its MagicDNS name (or Tailscale IP), where pi-host listens on HOST_PORT. */
	address: Type.String(),
	os: Type.Union([Type.Literal("darwin"), Type.Literal("linux")]),
	arch: Type.Union([Type.Literal("x64"), Type.Literal("arm64")]),
	user: Type.String(),
	home: Type.String(),
});
export type Host = Static<typeof Host>;

/** The settings' hosts JSON; entries that do not parse are dropped. */
export function parseHosts(json: string): Host[] {
	if (!json) return [];
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter((item): item is Host => Value.Check(Host, item)) : [];
	} catch {
		return [];
	}
}

function base(address: string): string {
	return `http://${address.includes(":") ? `[${address}]` : address}:${HOST_PORT}`;
}

/** What pi-host on `address` says about its computer; throws in words the user can act on. */
export async function probeHost(address: string, signal?: AbortSignal): Promise<HostInfo> {
	let response: Response;
	try {
		response = await fetch(`${base(address)}/info`, { signal: signal ?? AbortSignal.timeout(8000) });
	} catch {
		throw new Error(`連不到 ${address}：電腦要開著、連上 Tailscale，並裝好 pi-host`);
	}
	if (response.status === 403) throw new Error(`${address} 拒絕了這支手機：手機和電腦要登入同一個 Tailscale 帳號`);
	if (!response.ok) throw new Error(`${address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const info: unknown = await response.json();
	if (!Value.Check(HostInfo, info)) throw new Error(`${address} 的回應看不懂，pi-host 可能要更新`);
	return info;
}

/** A host from what it said about itself. */
export function hostFrom(address: string, info: HostInfo, id: string = crypto.randomUUID()): Host {
	return { id, name: info.name, address: info.dnsName || address, os: info.os, arch: info.arch, user: info.user, home: info.home };
}

class HostConnection extends StreamConnection {
	constructor(host: Host, ready: () => Promise<string>, onLog: (text: string) => void) {
		super({
			onLog,
			open: async (token, handlers) => {
				const sha = await ready();
				const url = new URL(`/env`, base(host.address).replace(/^http/, "ws"));
				url.searchParams.set("daemon", sha);
				url.searchParams.set("token", token);
				const socket = new WebSocket(url);
				socket.binaryType = "arraybuffer";
				// Listen before `open` resolves: the daemon's first bytes can arrive in the same task as the open event.
				socket.addEventListener("message", (event) => {
					if (event.data instanceof ArrayBuffer) handlers.onData(new Uint8Array(event.data));
				});
				return new Promise((resolve, reject) => {
					socket.addEventListener(
						"open",
						() => {
							socket.addEventListener("close", (event) => handlers.onClose(event.reason || undefined));
							resolve({
								send: (data) => {
									if (socket.readyState === WebSocket.OPEN) socket.send(data);
								},
								close: () => {
									if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
								},
							});
						},
						{ once: true },
					);
					socket.addEventListener("error", () => reject(lost(`連不到 ${host.name}（${host.address}）`)), { once: true });
				});
			},
		});
	}
}

export class HostSandbox implements Sandbox {
	readonly kind = "host";
	readonly direct = true;
	readonly host: Host;
	readonly #envs: SharedEnvs;
	#ready: Promise<string> | undefined;

	constructor(host: Host) {
		this.host = host;
		const onLog = (text: string) => log.warn("sandbox.daemon_output", { host: host.name, text });
		this.#envs = new SharedEnvs(new HostConnection(host, () => this.#daemon(), onLog), host.home, () => host.home);
	}

	/** The daemon for the computer's system, uploaded when it does not have it yet; once per app run. */
	#daemon(): Promise<string> {
		this.#ready ??= (async () => {
			const info = await probeHost(this.host.address);
			const { bytes, sha } = await daemon(info.os, info.arch);
			if (!info.daemons.includes(sha)) {
				const response = await fetch(`${base(this.host.address)}/daemon/${sha}`, { method: "PUT", body: new Blob([bytes.slice()]) });
				if (!response.ok) throw new Error(`上傳 pi-env 到 ${this.host.name} 失敗：HTTP ${response.status} ${(await response.text()).trim()}`);
			}
			return sha;
		})();
		this.#ready.catch(() => {
			this.#ready = undefined;
		});
		return this.#ready;
	}

	root(): string {
		return this.host.home;
	}

	env(folder: string): Promise<ExecutionEnv> {
		return this.#envs.env(folder);
	}

	async exists(): Promise<boolean> {
		return true;
	}

	remove(): Promise<void> {
		return Promise.reject(new Error("直接操作的電腦不會刪除檔案"));
	}

	describe(): string {
		return directDescription(this.host.name, this.host.user, this.host, "pi-host");
	}

	close(): void {
		this.#envs.close();
	}
}
