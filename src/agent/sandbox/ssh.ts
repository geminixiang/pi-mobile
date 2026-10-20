// SSH from the phone (android SshPlugin): connections to the owner's machines, exec channels as byte streams.
// The plugin owns the sockets; this module routes its `data`, `exit`, and `closed` events to the channel or connection
// they belong to. See docs/design/sandbox-ssh.md.
import { registerPlugin } from "@capacitor/core";

interface Target {
	host: string;
	port: number;
}

export interface HostKey {
	algorithm: string;
	/** Base64 of the key blob, as known_hosts stores it. */
	key: string;
	/** SHA256:..., as `ssh-keygen -l` prints it. */
	fingerprint: string;
}

interface DataEvent {
	channel: number;
	stream: "stdout" | "stderr";
	data: string;
}

interface ExitEvent {
	channel: number;
	code?: number;
	signal?: string;
}

interface ClosedEvent {
	connection: number;
	reason: string;
}

interface SshPlugin {
	publicKey(): Promise<{ publicKey: string }>;
	scanHostKey(options: Target): Promise<HostKey>;
	connect(options: Target & { user: string; hostKey: string }): Promise<{ connection: number }>;
	disconnect(options: { connection: number }): Promise<void>;
	exec(options: { connection: number; command: string }): Promise<{ channel: number }>;
	write(options: { channel: number; data: string }): Promise<void>;
	eof(options: { channel: number }): Promise<void>;
	close(options: { channel: number }): Promise<void>;
	addListener(event: "data", listener: (event: DataEvent) => void): Promise<{ remove(): Promise<void> }>;
	addListener(event: "exit", listener: (event: ExitEvent) => void): Promise<{ remove(): Promise<void> }>;
	addListener(event: "closed", listener: (event: ClosedEvent) => void): Promise<{ remove(): Promise<void> }>;
}

const Ssh = registerPlugin<SshPlugin>("Ssh");

export interface ChannelHandlers {
	onStdout(data: Uint8Array): void;
	onStderr?(data: Uint8Array): void;
	onExit(code: number | undefined, signal: string | undefined): void;
}

const channels = new Map<number, ChannelHandlers>();
/** Events that arrived before exec resolved with their channel id. */
const early = new Map<number, (DataEvent | ExitEvent)[]>();
const connectionClosed = new Map<number, (reason: string) => void>();

function decode(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function encode(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function deliver(handlers: ChannelHandlers, event: DataEvent | ExitEvent): void {
	if ("data" in event) {
		if (event.stream === "stdout") handlers.onStdout(decode(event.data));
		else handlers.onStderr?.(decode(event.data));
	} else {
		handlers.onExit(event.code, event.signal);
	}
}

function route(event: DataEvent | ExitEvent): void {
	const handlers = channels.get(event.channel);
	if (handlers) {
		deliver(handlers, event);
		if (!("data" in event)) channels.delete(event.channel);
		return;
	}
	const queue = early.get(event.channel) ?? [];
	queue.push(event);
	early.set(event.channel, queue);
}

let listening: Promise<unknown> | undefined;
function listen(): Promise<unknown> {
	listening ??= Promise.all([
		Ssh.addListener("data", route),
		Ssh.addListener("exit", route),
		Ssh.addListener("closed", (event) => connectionClosed.get(event.connection)?.(event.reason)),
	]);
	return listening;
}

export function appPublicKey(): Promise<string> {
	return Ssh.publicKey().then((result) => result.publicKey);
}

export function scanHostKey(host: string, port: number): Promise<HostKey> {
	return Ssh.scanHostKey({ host, port });
}

export interface SshChannel {
	write(data: Uint8Array): void;
	/** End stdin: the remote command sees end of input. */
	end(): void;
	close(): void;
}

/** One authenticated connection; channels share it. */
export class SshClient {
	readonly #id: number;
	#closed = false;
	#onClose = new Set<(reason: string) => void>();

	private constructor(id: number) {
		this.#id = id;
		connectionClosed.set(id, (reason) => this.#lost(reason));
	}

	static async connect(target: Target & { user: string; hostKey: string }): Promise<SshClient> {
		await listen();
		const { connection } = await Ssh.connect(target);
		return new SshClient(connection);
	}

	get closed(): boolean {
		return this.#closed;
	}

	onClose(listener: (reason: string) => void): () => void {
		this.#onClose.add(listener);
		return () => this.#onClose.delete(listener);
	}

	async exec(command: string, handlers: ChannelHandlers): Promise<SshChannel> {
		if (this.#closed) throw new Error("SSH 連線已經斷了");
		const { channel } = await Ssh.exec({ connection: this.#id, command });
		channels.set(channel, handlers);
		for (const event of early.get(channel) ?? []) deliver(handlers, event);
		early.delete(channel);
		// Writes go in order through the plugin's per-channel writer; nothing here waits for them.
		return {
			write: (data) => void Ssh.write({ channel, data: encode(data) }).catch(() => undefined),
			end: () => void Ssh.eof({ channel }).catch(() => undefined),
			close: () => void Ssh.close({ channel }).catch(() => undefined),
		};
	}

	/** Run a command to the end: its stdout as text, stderr, and exit code. `input` is sent as stdin. */
	run(command: string, input?: Uint8Array): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
		return new Promise((resolve, reject) => {
			const out: Uint8Array[] = [];
			const err: Uint8Array[] = [];
			const text = (parts: Uint8Array[]) => new TextDecoder().decode(concat(parts));
			this.exec(command, {
				onStdout: (data) => out.push(data),
				onStderr: (data) => err.push(data),
				onExit: (code) => resolve({ stdout: text(out), stderr: text(err), code }),
			}).then((channel) => {
				if (input) {
					// The plugin's bridge carries base64 strings; large inputs go in pieces.
					for (let i = 0; i < input.length; i += 256 * 1024) channel.write(input.subarray(i, i + 256 * 1024));
				}
				channel.end();
			}, reject);
		});
	}

	close(): void {
		if (this.#closed) return;
		void Ssh.disconnect({ connection: this.#id }).catch(() => undefined);
		this.#lost("closed");
	}

	#lost(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		connectionClosed.delete(this.#id);
		for (const listener of this.#onClose) listener(reason);
	}
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
