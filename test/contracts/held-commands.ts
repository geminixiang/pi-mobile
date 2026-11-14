import assert from "node:assert/strict";
import { McpClient } from "@earendil-works/pi-mcp";
import wire from "../../host/protocol.json" with { type: "json" };
import { type Dial, HostCommands, hostStdio } from "../../src/agent/sandbox/host.ts";
import type { RawMessage } from "../../src/agent/sandbox/resumable-link.ts";
import type { RawSocket } from "../../src/agent/sandbox/resumable-socket.ts";
import type { Check } from "./setup.ts";

type Out = Uint8Array | string;
type Computer = { emit(data: Out): void; drop(): void };
type Program = { line?(line: string, computer: Computer): void; ended?(computer: Computer): void };
type Live = { onMessage: (data: RawMessage) => void; onClose: (reason: string | undefined) => void; closed: boolean };

const REACH = { address: "computer", name: "computer", key: "k" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const stdout = (text: string) => new Uint8Array([wire.stdout, ...encoder.encode(text)]);

function computer(program: Program): Dial {
	const sent: Out[] = [];
	const state: { live: Live | undefined; held: boolean; received: number; buffer: string } = { live: undefined, held: false, received: 0, buffer: "" };
	const deliver = (data: Out) => state.live?.onMessage(typeof data === "string" ? data : data.slice().buffer);
	const self: Computer = {
		emit: (data) => {
			sent.push(data);
			deliver(data);
		},
		drop: () => {
			const live = state.live;
			if (!live) return;
			state.live = undefined;
			live.closed = true;
			setTimeout(() => live.onClose(undefined), 0);
		},
	};
	return {
		network: { online: () => true, onChange: () => () => undefined },
		open: async (url, _what, onMessage, onClose): Promise<RawSocket> => {
			const attach = url.searchParams.get("attach");
			if (attach === null) state.held = url.searchParams.get("session") !== null;
			if (attach !== null && !state.held) throw new Error("nothing is held to attach to");
			const live: Live = { onMessage, onClose, closed: false };
			state.live = live;
			if (attach !== null) {
				const have = Number(url.searchParams.get("received"));
				setTimeout(() => {
					onMessage(JSON.stringify({ received: state.received }));
					for (const data of sent.slice(have)) deliver(data);
				}, 0);
			}
			return {
				send: (data) => {
					if (live.closed) return;
					state.received++;
					if (data === wire.endOfInput) return program.ended?.(self);
					state.buffer += typeof data === "string" ? data : decoder.decode(data);
					const lines = state.buffer.split("\n");
					state.buffer = lines.pop() ?? "";
					for (const line of lines) program.line?.(line, self);
				},
				close: () => {
					live.closed = true;
					if (state.live === live) state.live = undefined;
				},
			};
		},
	};
}

function finishesAfterADrop(output: (computer: Computer) => void): (computer: Computer) => void {
	return (computer) => {
		computer.drop();
		setTimeout(() => output(computer), 50);
	};
}

export const checks: Check[] = [
	[
		"a command the phone sent goes on through a dropped link, and the phone still gets its output and exit code once it reattaches",
		async () => {
			const dial = computer({
				ended: finishesAfterADrop((computer) => {
					computer.emit(stdout("pasted and entered\n"));
					computer.emit(JSON.stringify({ exit: 0 }));
				}),
			});
			assert.deepEqual(await new HostCommands(REACH, dial).run("send the task"), { stdout: "pasted and entered\n", stderr: "", code: 0 });
		},
	],
	[
		"a screen action on the computer goes on through a dropped link, and the phone still gets its result instead of an error that invites doing it again",
		async () => {
			const dial = computer({
				line: (line, computer) => {
					const request: { id?: number; method: string } = JSON.parse(line);
					const reply = (result: unknown) => computer.emit(stdout(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`));
					if (request.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "computer", version: "0" } });
					if (request.method === "tools/call") return finishesAfterADrop(() => reply({ content: [{ type: "text", text: "typed STEP-ONE STEP-TWO" }] }))(computer);
				},
			});
			const client = new McpClient({ name: "pi-mobile", version: "1.0.0" });
			await client.connect(hostStdio(REACH, "pi-mobile mcp computer", dial));
			const result = await client.callTool("act", { steps: [{ action: "type", text: "STEP-ONE STEP-TWO" }] });
			await client.close();
			assert.deepEqual(result.content, [{ type: "text", text: "typed STEP-ONE STEP-TWO" }]);
		},
	],
];
