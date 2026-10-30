import assert from "node:assert/strict";
import { READ_CHUNK, readWhole } from "../../src/agent/files/phone-env.ts";
import type { Check } from "./setup.ts";

function file(size: number) {
	const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
	const ranges: number[] = [];
	const read = async (offset: number, length: number) => {
		ranges.push(length);
		if (length > READ_CHUNK) throw new Error(`asked the phone for ${length} bytes at once`);
		return { size, bytes: bytes.slice(offset, offset + length) };
	};
	return { bytes, ranges, read };
}

export const checks: Check[] = [
	[
		"a file larger than one read comes over in pieces and arrives whole",
		async () => {
			const big = file(READ_CHUNK * 2 + 123);
			assert.deepEqual(await readWhole(big.read), big.bytes);
			assert.deepEqual(big.ranges, [READ_CHUNK, READ_CHUNK, 123]);
		},
	],
	[
		"a small file is one read",
		async () => {
			const small = file(10);
			assert.deepEqual(await readWhole(small.read), small.bytes);
			assert.deepEqual(small.ranges, [READ_CHUNK]);
		},
	],
];
