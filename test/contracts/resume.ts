import assert from "node:assert/strict";
import { type Link, RESUME_LIMIT_MS, type RawMessage, type RawSocket, ResumableSocket } from "../../src/agent/sandbox/resumable-socket.ts";
import type { Check } from "./setup.ts";
import wire from "../../host/protocol.json" with { type: "json" };
import { sleep } from "../../src/promise.ts";

type Fake = RawSocket & { url: URL; sent: (string | Uint8Array)[]; deliver(data: RawMessage): void; drop(reason?: string): void; closed: boolean; closeCode: number | undefined };

function fakeOpener() {
	const sockets: Fake[] = [];
	const open = async (url: URL, _what: string, onMessage: (data: RawMessage) => void, onClose: (reason: string | undefined) => void): Promise<RawSocket> => {
		if (url.searchParams.get("fail") === "1") throw new Error("unreachable");
		const socket: Fake = {
			url,
			sent: [],
			closed: false,
			closeCode: undefined,
			send: (data) => socket.sent.push(data),
			close: (code) => {
				socket.closed = true;
				socket.closeCode = code;
			},
			deliver: (data) => onMessage(data),
			drop: (reason) => onClose(reason),
		};
		sockets.push(socket);
		return socket;
	};
	return { open, sockets };
}


async function opened(opener: ReturnType<typeof fakeOpener>, index: number): Promise<Fake> {
	for (let waited = 0; waited < 5000; waited += 20) {
		const socket = opener.sockets[index];
		if (socket) return socket;
		await sleep(20);
	}
	throw new Error(`socket ${index} never opened`);
}

function fakeNetwork() {
	const listeners = new Set<() => void>();
	let online = true;
	return {
		online: () => online,
		onChange: (listener: () => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		set(next: boolean) {
			online = next;
			for (const listener of listeners) listener();
		},
	};
}

async function connect(opener: ReturnType<typeof fakeOpener>, network = fakeNetwork(), resumeLimitMs = RESUME_LIMIT_MS) {
	const links: Link[] = [];
	const received: RawMessage[] = [];
	let closedWith: string | undefined | null = null;
	const socket = await ResumableSocket.connect({
		quietLimitMs: 400,
		first: new URL("ws://computer/env?token=t"),
		attach: (have) => new URL(`ws://computer/env?attach=t&received=${have}`),
		open: opener.open,
		what: "computer",
		onMessage: (data) => received.push(data),
		onClose: (reason) => {
			closedWith = reason;
		},
		onLink: (link) => links.push(link),
		network,
		resumeLimitMs,
	});
	return { socket, links, received, closed: () => closedWith };
}

export const checks: Check[] = [
	[
		"a dropped socket comes back with the messages each side missed, and only those",
		async () => {
			const opener = fakeOpener();
			const { socket, links, received, closed } = await connect(opener);
			const first = opener.sockets[0];
			assert(first);
			socket.send("one");
			socket.send("two");
			first.deliver("from computer 1");
			first.deliver("from computer 2");
			first.drop(undefined);
			assert.deepEqual(links, ["reattaching"]);
			socket.send("three");
			assert.deepEqual(first.sent, ["one", "two"]);
			await sleep(1200);
			const second = opener.sockets[1];
			assert(second, "no attach attempt after a second");
			assert.equal(second.url.searchParams.get("attach"), "t");
			assert.equal(second.url.searchParams.get("received"), "2");
			second.deliver(JSON.stringify({ received: 1 }));
			assert.deepEqual(second.sent, ["two", "three"]);
			assert.deepEqual(links, ["reattaching", "up"]);
			second.deliver("from computer 3");
			assert.deepEqual(received, ["from computer 1", "from computer 2", "from computer 3"]);
			socket.send("four");
			assert.deepEqual(second.sent, ["two", "three", "four"]);
			assert.equal(closed(), null);
			socket.close();
			assert(second.closed);
		},
	],
	[
		"a close with a reason is final, and a failed attach is retried until one answers",
		async () => {
			const opener = fakeOpener();
			const { socket, links, closed } = await connect(opener);
			const first = opener.sockets[0];
			assert(first);
			first.drop(undefined);
			await sleep(1200);
			const second = opener.sockets[1];
			assert(second);
			second.drop(undefined);
			await sleep(2200);
			const third = opener.sockets[2];
			assert(third, "no second attach attempt");
			third.deliver(JSON.stringify({ received: 0 }));
			assert.deepEqual(links, ["reattaching", "up"]);
			third.drop("no such session");
			assert.equal(closed(), "no such session");
			socket.send("after");
			await sleep(1200);
			assert.equal(opener.sockets.length, 3);
		},
	],
	[
		"a socket that looks alive but stays quiet past the limit is dropped and attached again",
		async () => {
			const opener = fakeOpener();
			const { socket, links } = await connect(opener);
			const first = opener.sockets[0];
			assert(first);
			first.deliver("a");
			await sleep(200);
			first.deliver("b");
			await sleep(300);
			assert(!first.closed);
			assert.deepEqual(links, []);
			await sleep(400);
			assert(first.closed);
			assert.equal(first.closeCode, undefined);
			assert.deepEqual(links, ["reattaching"]);
			const second = await opened(opener, 1);
			assert.equal(second.url.searchParams.get("received"), "2");
			await sleep(50);
			second.deliver(JSON.stringify({ received: 0 }));
			assert.deepEqual(links, ["reattaching", "up"]);
			socket.close();
		},
	],
	[
		"closing on purpose tells the computer to end the session",
		async () => {
			const opener = fakeOpener();
			const { socket } = await connect(opener);
			socket.close();
			assert.equal(opener.sockets[0]?.closeCode, 1000);
		},
	],
	[
		"an attach the computer never answers is given up and tried again",
		async () => {
			const opener = fakeOpener();
			const { socket, links } = await connect(opener);
			opener.sockets[0]?.drop();
			const silent = await opened(opener, 1);
			await sleep(600);
			assert(silent.closed);
			assert.equal(silent.closeCode, undefined);
			const next = await opened(opener, 2);
			next.deliver(JSON.stringify({ received: 0 }));
			assert.deepEqual(links, ["reattaching", "up"]);
			socket.close();
		},
	],
	[
		"while the phone is offline it waits without trying, and reattaches as soon as the network is back",
		async () => {
			const opener = fakeOpener();
			const network = fakeNetwork();
			const { socket, links, closed } = await connect(opener, network);
			const first = opener.sockets[0];
			assert(first);
			first.deliver("from computer 1");
			network.set(false);
			first.drop(undefined);
			assert.deepEqual(links, ["offline"]);
			await sleep(1500);
			assert.equal(opener.sockets.length, 1, "it tried to reattach with no network");
			const back = Date.now();
			network.set(true);
			const second = await opened(opener, 1);
			assert(Date.now() - back < 300, "it waited for the next retry instead of reattaching when the network came back");
			await sleep(50);
			second.deliver(JSON.stringify({ received: 0 }));
			assert.deepEqual(links, ["offline", "reattaching", "up"]);
			assert.equal(closed(), null);
			socket.close();
		},
	],
	[
		"time without a network does not count toward giving up",
		async () => {
			const opener = fakeOpener();
			const network = fakeNetwork();
			const { socket, links, closed } = await connect(opener, network, 300);
			const first = opener.sockets[0];
			assert(first);
			network.set(false);
			first.drop(undefined);
			await sleep(700);
			network.set(true);
			const second = await opened(opener, 1);
			await sleep(50);
			second.deliver(JSON.stringify({ received: 0 }));
			assert.equal(closed(), null, `it gave up while offline: ${closed()}`);
			assert.deepEqual(links, ["offline", "reattaching", "up"]);
			socket.close();
		},
	],
	[
		"coming back to the foreground reattaches right away instead of waiting out the backoff",
		async () => {
			const opener = fakeOpener();
			const network = fakeNetwork();
			const { socket } = await connect(opener, network);
			const first = opener.sockets[0];
			assert(first);
			first.drop(undefined);
			await sleep(100);
			const shown = Date.now();
			network.set(true);
			const second = await opened(opener, 1);
			assert(Date.now() - shown < 300, "it waited for the scheduled retry after the app came back");
			await sleep(50);
			second.deliver(JSON.stringify({ received: 0 }));
			socket.close();
		},
	],
	[
		"the phone gives up reattaching before the computer lets the held session go, so a phone that comes back in time finds it",
		async () => {
			assert(RESUME_LIMIT_MS < wire.holdMinutes * 60_000, `the phone tries for ${RESUME_LIMIT_MS / 60_000} min but the computer holds for ${wire.holdMinutes} min`);
		},
	],
];
