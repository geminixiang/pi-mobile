import { gunzipSync as inflateGzip, gzipSync as deflateGzip } from "fflate";

const FFLATE_DEFAULT_LEVEL = 6;

export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };

type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

function levelOf(level: number | undefined): Level {
	const wanted = level === undefined || level < 0 ? FFLATE_DEFAULT_LEVEL : Math.min(9, Math.round(level));
	const levels: Level[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
	return levels[wanted] ?? FFLATE_DEFAULT_LEVEL;
}

function withinLimit(output: Uint8Array, maxOutputLength: number | undefined): Uint8Array {
	if (maxOutputLength !== undefined && output.length > maxOutputLength) throw new RangeError("Cannot create a Buffer larger than maxOutputLength");
	return output;
}

export function gzipSync(input: Uint8Array, options: { level?: number; maxOutputLength?: number } = {}): Uint8Array {
	return withinLimit(deflateGzip(input, { level: levelOf(options.level) }), options.maxOutputLength);
}

export function gunzipSync(input: Uint8Array, options: { maxOutputLength?: number } = {}): Uint8Array {
	return withinLimit(inflateGzip(input), options.maxOutputLength);
}

export default { gzipSync, gunzipSync, constants };
