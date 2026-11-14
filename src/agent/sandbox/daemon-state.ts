import { Buffer } from "buffer";
import type { Link } from "./resumable-link.ts";

export interface DaemonStream {
	send(data: Uint8Array<ArrayBuffer>): void;
	close(): void;
}

type Line = { readonly kind: "up" } | { readonly kind: "down"; readonly link: Exclude<Link, "up">; readonly since: number };

export type Daemon =
	| { readonly kind: "opening"; readonly queued: readonly Uint8Array<ArrayBuffer>[] }
	| { readonly kind: "open"; readonly stream: DaemonStream; readonly line: Line }
	| { readonly kind: "ended" };

export type DaemonEvent =
	| { kind: "opened"; stream: DaemonStream }
	| { kind: "failed"; reason: string }
	| { kind: "end"; reason: string }
	| { kind: "link"; link: Link; now: number }
	| { kind: "write"; data: Uint8Array<ArrayBuffer> };

export type DaemonEffect =
	| { kind: "send"; stream: DaemonStream; data: readonly Uint8Array<ArrayBuffer>[] }
	| { kind: "close"; stream: DaemonStream }
	| { kind: "error"; reason: string }
	| { kind: "lost"; reason: string }
	| { kind: "status" };

type DaemonStep = { state: Daemon; effects: DaemonEffect[] };

export function daemonStep(state: Daemon, event: DaemonEvent): DaemonStep {
	const same: DaemonStep = { state, effects: [] };
	switch (event.kind) {
		case "opened":
			if (state.kind !== "opening") return { state, effects: [{ kind: "close", stream: event.stream }] };
			return { state: { kind: "open", stream: event.stream, line: { kind: "up" } }, effects: [{ kind: "send", stream: event.stream, data: state.queued }] };
		case "failed":
			if (state.kind !== "opening") return same;
			return { state: { kind: "ended" }, effects: [{ kind: "error", reason: event.reason }, { kind: "lost", reason: event.reason }] };
		case "end":
			if (state.kind === "ended") return same;
			return { state: { kind: "ended" }, effects: state.kind === "open" ? [{ kind: "close", stream: state.stream }, { kind: "lost", reason: event.reason }] : [{ kind: "lost", reason: event.reason }] };
		case "link":
			if (state.kind !== "open") return same;
			return { state: { ...state, line: event.link === "up" ? { kind: "up" } : { kind: "down", link: event.link, since: event.now } }, effects: [{ kind: "status" }] };
		case "write":
			if (state.kind === "opening") return { state: { kind: "opening", queued: [...state.queued, event.data] }, effects: [] };
			if (state.kind === "open") return { state, effects: [{ kind: "send", stream: state.stream, data: [event.data] }] };
			return same;
	}
}

export function lineOf(state: Daemon): Line {
	return state.kind === "open" ? state.line : { kind: "up" };
}

const MAX_FRAME = 16 * 1024 * 1024 + 64;

export type Reader =
	| { readonly kind: "greeting"; readonly pending: Buffer }
	| { readonly kind: "framed"; readonly pending: readonly Uint8Array[]; readonly bytes: number; readonly need: number };

type Read = { reader: Reader; frames: Buffer | undefined; greeted: boolean };

function joined(chunks: readonly Uint8Array[], length: number): Buffer {
	const [only] = chunks;
	return chunks.length === 1 && only ? Buffer.from(only.buffer, only.byteOffset, only.byteLength) : Buffer.concat(chunks, length);
}

export function read(reader: Reader, data: Uint8Array, marker: Buffer): Read {
	if (reader.kind === "greeting") {
		const pending = joined([reader.pending, data], reader.pending.length + data.byteLength);
		const index = pending.indexOf(marker);
		if (index === -1) return { reader: { kind: "greeting", pending }, frames: undefined, greeted: false };
		return { ...frame(pending, index + marker.length), greeted: true };
	}
	const pending = [...reader.pending, data];
	const bytes = reader.bytes + data.byteLength;
	if (bytes < reader.need) return { reader: { kind: "framed", pending, bytes, need: reader.need }, frames: undefined, greeted: false };
	return { ...frame(joined(pending, bytes), 0), greeted: false };
}

function frame(pending: Buffer, start: number): { reader: Reader; frames: Buffer | undefined } {
	let end = start;
	while (pending.length - end >= 4) {
		const length = pending.readUInt32BE(end);
		if (length > MAX_FRAME) {
			end = pending.length;
			break;
		}
		if (pending.length - end < 4 + length) break;
		end += 4 + length;
	}
	const rest = pending.subarray(end);
	const reader: Reader = {
		kind: "framed",
		pending: rest.length > 0 ? [new Uint8Array(rest)] : [],
		bytes: rest.length,
		need: rest.length >= 4 ? 4 + rest.readUInt32BE(0) : 4,
	};
	return { reader, frames: end > 0 ? pending.subarray(0, end) : undefined };
}
