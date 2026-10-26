import assert from "node:assert/strict";
import { type RawMessage, type RawSocket, ResumableSocket } from "../../src/agent/sandbox/resumable-socket.ts";
import type { Check } from "./setup.ts";

type Fake = RawSocket & { url: URL; sent: (string | Uint8Array)[]; deliver(data: RawMessage): void; drop(reason?: string): void; closed: boolean };

function fakeOpener() {
	const sockets: Fake[] = [];
	const open = async (url: URL, _what: string, onMessage: (data: RawMessage) => void, onClose: (reason: string | undefined) => void): Promise<RawSocket> => {
		if (url.searchParams.get("fail") === "1") throw new Error("unreachable");
		const socket: Fake = {
			url,
			sent: [],
			closed: false,
			send: (data) => socket.sent.push(data),
			close: () => {
				socket.closed = true;
			},
			deliver: (data) => onMessage(data),
			drop: (reason) => onClose(reason),
		};
		sockets.push(socket);
		return socket;
	};
	return { open, sockets };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(opener: ReturnType<typeof fakeOpener>) {
	const links: boolean[] = [];
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
		onLink: (up) => links.push(up),
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
			assert.deepEqual(links, [false]);
			socket.send("three");
			assert.deepEqual(first.sent, ["one", "two"]);
			await sleep(1200);
			const second = opener.sockets[1];
			assert(second, "no attach attempt after a second");
			assert.equal(second.url.searchParams.get("attach"), "t");
			assert.equal(second.url.searchParams.get("received"), "2");
			second.deliver(JSON.stringify({ received: 1 }));
			assert.deepEqual(second.sent, ["two", "three"]);
			assert.deepEqual(links, [false, true]);
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
			assert.deepEqual(links, [false, true]);
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
			assert.deepEqual(links, [false]);
			await sleep(1200);
			const second = opener.sockets[1];
			assert(second);
			assert.equal(second.url.searchParams.get("received"), "2");
			second.deliver(JSON.stringify({ received: 0 }));
			assert.deepEqual(links, [false, true]);
			socket.close();
		},
	],
];
