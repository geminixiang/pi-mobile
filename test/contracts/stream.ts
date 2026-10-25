import assert from "node:assert/strict";
import { RemoteError } from "@earendil-works/pi-env";
import { type ConnectionStatus, StreamConnection } from "../../src/agent/sandbox/stream-connection.ts";
import type { Check } from "./setup.ts";

const RESULT = 2;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function reply(id: number, json: Record<string, unknown>): Uint8Array<ArrayBuffer> {
	const body = encoder.encode(JSON.stringify(json));
	const out = new Uint8Array(13 + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 9 + body.length);
	view.setUint8(4, RESULT);
	view.setUint32(5, id);
	view.setUint32(9, body.length);
	out.set(body, 13);
	return out;
}

type Daemon = { connection: StreamConnection; sent: string[]; drop: (reason: string) => void; link: (up: boolean) => void; answer: (id: number, json: Record<string, unknown>) => void; statuses: ConnectionStatus[] };

function daemonAnswering(hello: Record<string, unknown>): Daemon {
	const sent: string[] = [];
	const statuses: ConnectionStatus[] = [];
	let drop: (reason: string) => void = () => undefined;
	let link: (up: boolean) => void = () => undefined;
	let answer: (id: number, json: Record<string, unknown>) => void = () => undefined;
	const connection = new StreamConnection({
		open: async (token, handlers) => {
			drop = (reason) => handlers.onClose(reason);
			link = (up) => handlers.onLink?.(up);
			answer = (id, json) => handlers.onData(reply(id, json));
			let greeted = false;
			return {
				send: (data) => {
					if (!greeted) handlers.onData(encoder.encode(`PI-ENV ${token}\n`));
					greeted = true;
					const view = new DataView(data.buffer, data.byteOffset);
					const id = view.getUint32(5);
					const jsonLength = view.getUint32(9);
					const request = JSON.parse(decoder.decode(data.subarray(13, 13 + jsonLength)));
					sent.push(`${request.op}:${id}`);
					if (request.op === "hello") queueMicrotask(() => handlers.onData(reply(id, hello)));
				},
				close: () => undefined,
			};
		},
		onStatus: (status) => statuses.push(status),
	});
	return { connection, sent, drop: (reason) => drop(reason), link: (up) => link(up), answer: (id, json) => answer(id, json), statuses };
}

function lostError(error: unknown): error is RemoteError {
	return error instanceof RemoteError && error.fields.lost === true;
}

const fullHello = {
	protocol: 1,
	version: "0.7.0",
	os: "linux",
	arch: "arm64",
	home: "/home/fixture",
	tmpdir: "/tmp",
	separator: "/",
	cwd: "/home/fixture",
	driveCwds: {},
	pid: 42,
};

export const checks: Check[] = [
	[
		"a daemon's hello is checked field by field before it is trusted",
		async () => {
			const { home: _home, ...withoutHome } = fullHello;
			const { connection } = daemonAnswering(withoutHome);
			try {
				await assert.rejects(connection.info(), (error: unknown) => error instanceof RemoteError && error.fields.lost === true && /hello.*home/.test(error.message));
			} finally {
				connection.close();
			}
		},
	],
	[
		"a complete hello becomes the remote info",
		async () => {
			const { connection } = daemonAnswering(fullHello);
			try {
				const info = await connection.info();
				assert.equal(info.home, "/home/fixture");
				assert.equal(info.pid, 42);
			} finally {
				connection.close();
			}
		},
	],
	[
		"a request the daemon had received fails as unknown outcome when the connection drops, one it never received as unsent",
		async () => {
			const { connection, sent, drop } = daemonAnswering(fullHello);
			try {
				const session = await connection.session();
				const inFlight = connection.request("exec", { command: "gh pr create" }, { session });
				assert.deepEqual(sent, ["hello:1", "exec:2"]);
				drop("socket dropped");
				await assert.rejects(inFlight, (error: unknown) => lostError(error) && error.fields.outcome === "unknown" && /had been sent/.test(error.message) && error.message.includes("socket dropped"));
				await assert.rejects(connection.request("exec", { command: "gh pr create" }, { session }), (error: unknown) => lostError(error) && error.fields.outcome === "unsent" && /before the request was sent/.test(error.message));
				assert.deepEqual(sent, ["hello:1", "exec:2"]);
			} finally {
				connection.close();
			}
		},
	],
	[
		"the connection reports connecting, connected, and lost with the reason, and closed only on close",
		async () => {
			const { connection, drop, statuses } = daemonAnswering(fullHello);
			try {
				assert.deepEqual(connection.status, { kind: "idle" });
				const session = await connection.session();
				assert.deepEqual(statuses, [{ kind: "connecting" }, { kind: "connected", session }]);
				drop("socket dropped");
				const last = statuses.at(-1);
				assert(last?.kind === "lost");
				assert.equal(last.reason, "pi-env connection lost: socket dropped");
				assert.equal(connection.status, last);
			} finally {
				connection.close();
			}
			assert.deepEqual(connection.status, { kind: "closed" });
		},
	],
	[
		"a request outlives a link that goes down and comes back, and its answer still lands",
		async () => {
			const { connection, sent, drop, link, answer, statuses } = daemonAnswering(fullHello);
			try {
				const session = await connection.session();
				const inFlight = connection.request("exec", { command: "sleep 90" }, { session });
				const id = Number(sent.at(-1)?.split(":")[1]);
				link(false);
				const down = statuses.at(-1);
				assert(down?.kind === "reattaching" && down.session === session);
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.equal(connection.status.kind, "reattaching");
				link(true);
				assert.deepEqual(connection.status, { kind: "connected", session });
				answer(id, { exitCode: 0 });
				assert.deepEqual((await inFlight).json, { exitCode: 0 });
				drop("pi-env exited");
				assert.equal(connection.status.kind, "lost");
			} finally {
				connection.close();
			}
		},
	],
];
