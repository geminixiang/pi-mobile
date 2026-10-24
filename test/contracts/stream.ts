import assert from "node:assert/strict";
import { RemoteError } from "@earendil-works/pi-env";
import { StreamConnection } from "../../src/agent/sandbox/stream-connection.ts";
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

function daemonAnswering(hello: Record<string, unknown>): StreamConnection {
	return new StreamConnection({
		open: async (token, handlers) => ({
			send: (data) => {
				handlers.onData(encoder.encode(`PI-ENV ${token}\n`));
				const view = new DataView(data.buffer, data.byteOffset);
				const id = view.getUint32(5);
				const jsonLength = view.getUint32(9);
				const request = JSON.parse(decoder.decode(data.subarray(13, 13 + jsonLength)));
				if (request.op === "hello") queueMicrotask(() => handlers.onData(reply(id, hello)));
			},
			close: () => undefined,
		}),
	});
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
			const connection = daemonAnswering(withoutHome);
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
			const connection = daemonAnswering(fullHello);
			try {
				const info = await connection.info();
				assert.equal(info.home, "/home/fixture");
				assert.equal(info.pid, 42);
			} finally {
				connection.close();
			}
		},
	],
];
