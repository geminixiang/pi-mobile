import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { log } from "../../log.ts";
import { onFailure, untilFailure } from "../../promise.ts";
import { deviceDial, HostCommands, holdSocket } from "../../computer/commands.ts";
import { type HostMode, type PairedHost, probeHost, url } from "../../computer/pairing.ts";
import { ContainerHost, type Credentials } from "./container.ts";
import { daemon } from "./daemon.ts";
import { containerDescription, directDescription, type Sandbox, SharedEnvs } from "./sandbox.ts";
import { type ConnectionStatus, type OpenDaemon, PhoneConnection } from "./phone-connection.ts";
import { WORKSPACE } from "./workspace.ts";

type Preparing = { done: Promise<void>; listeners: Set<(detail: string) => void> };

const preparing = new Map<string, Preparing>();

function follow(entry: Preparing, onProgress: (detail: string) => void): Promise<void> {
	entry.listeners.add(onProgress);
	return entry.done.finally(() => entry.listeners.delete(onProgress));
}

export function watchPrepare(host: PairedHost, onProgress: (detail: string) => void): Promise<void> | undefined {
	const entry = preparing.get(host.address);
	return entry ? follow(entry, onProgress) : undefined;
}

export function prepareContainers(host: PairedHost, onProgress: (detail: string) => void): Promise<void> {
	if (!host.engine) return Promise.reject(new Error(`${host.name} 沒有 docker、podman 或 nerdctl`));
	const known = preparing.get(host.address);
	if (known) return follow(known, onProgress);
	const listeners = new Set<(detail: string) => void>();
	const done = new ContainerHost(host.engine, new HostCommands(host), host.home).ensureImages((detail) => {
		for (const listener of listeners) listener(detail);
	});
	const entry = { done, listeners };
	preparing.set(host.address, entry);
	onFailure(done, () => preparing.delete(host.address));
	return follow(entry, onProgress);
}

export class HostSandbox implements Sandbox {
	readonly host: PairedHost;
	readonly direct: boolean;
	readonly #envs: SharedEnvs;
	readonly #startBridge: (() => () => void) | undefined;
	#stopBridge: (() => void) | undefined;
	#status: ConnectionStatus = { kind: "idle" };
	readonly #listeners = new Set<(status: ConnectionStatus) => void>();

	constructor(host: PairedHost, mode: HostMode, credentials: Credentials) {
		this.host = host;
		const engine = mode === "container" ? host.engine : undefined;
		this.direct = !engine;
		const onLog = (text: string) => log.warn("sandbox.daemon_output", { host: host.name, text });
		const onStatus = (status: ConnectionStatus) => {
			this.#status = status;
			log.info("host.connection", { host: host.name, mode, status: status.kind, ...(status.kind === "lost" ? { reason: status.reason } : {}) });
			for (const listener of this.#listeners) listener(status);
		};
		if (engine) {
			const containers = new ContainerHost(engine, new HostCommands(host), host.home);
			this.#startBridge = () => containers.bridge(credentials);
			const serviceEnv = () => Object.assign({}, ...Object.values(credentials.minted).map((service) => service.env));
			const connection = new PhoneConnection({ open: containers.opener(serviceEnv), onLog, onStatus });
			this.#envs = new SharedEnvs(connection, WORKSPACE, (folder) => `${WORKSPACE}/${folder}`);
		} else {
			this.#envs = new SharedEnvs(new PhoneConnection({ open: this.#direct(), onLog, onStatus }), host.home, () => host.home);
		}
	}

	get status(): ConnectionStatus {
		return this.#status;
	}

	subscribe(listener: (status: ConnectionStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#direct(): OpenDaemon {
		return async (token, handlers) => {
			const sha = await this.#daemon();
			const socket = await holdSocket(this.host, `${this.host.name}（${this.host.address}）`, "/env", { daemon: sha, token }, token, deviceDial, {
				onMessage: (data) => {
					if (data instanceof ArrayBuffer) handlers.onData(new Uint8Array(data));
				},
				onClose: handlers.onClose,
				onLink: handlers.onLink,
			});
			return { send: (data) => socket.send(data), close: () => socket.close() };
		};
	}

	readonly #daemon = untilFailure(async () => {
		const info = await probeHost(this.host);
		const { bytes, sha } = daemon(info.os, info.arch);
		if (!info.daemons.includes(sha)) {
			const response = await fetch(url(this.host, `/daemon/${sha}`), { method: "PUT", body: new Blob([await bytes()]) });
			if (!response.ok) throw new Error(`上傳 pi-env 到 ${this.host.name} 失敗：HTTP ${response.status} ${(await response.text()).trim()}`);
		}
		return sha;
	});

	root(folder: string): string {
		return this.#envs.root(folder);
	}

	async env(folder: string): Promise<ExecutionEnv> {
		if (!this.direct) await prepareContainers(this.host, (detail) => log.info("host.prepare", { host: this.host.name, detail }));
		if (this.#startBridge && !this.#stopBridge) this.#stopBridge = this.#startBridge();
		return this.#envs.env(folder);
	}

	exists(folder: string): Promise<boolean> {
		return this.direct ? Promise.resolve(true) : this.#envs.exists(folder);
	}

	remove(folder: string): Promise<void> {
		if (this.direct) return Promise.reject(new Error("直接操作的電腦不會刪除檔案"));
		return this.#envs.remove(folder);
	}

	describe(folder: string): string {
		return this.direct ? directDescription(this.host) : containerDescription(folder);
	}

	close(): void {
		this.#stopBridge?.();
		this.#envs.close();
	}
}

