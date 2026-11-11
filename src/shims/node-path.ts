import path from "path-browserify";

const DRIVE = /^[A-Za-z]:/;
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/;
const SEPARATORS = /[\\/]+/;

type Parsed = { device: string; absolute: boolean; parts: string[] };

function parse(input: string): Parsed {
	const unc = UNC.exec(input);
	if (unc) return { device: `\\\\${unc[1]}\\${unc[2]}`, absolute: true, parts: input.slice(unc[0].length).split(SEPARATORS) };
	const device = DRIVE.exec(input)?.[0] ?? "";
	const rest = input.slice(device.length);
	return { device, absolute: rest.startsWith("\\") || rest.startsWith("/"), parts: rest.split(SEPARATORS) };
}

function collapse(parts: readonly string[], absolute: boolean): string[] {
	const kept: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === ".." && kept.length > 0 && kept.at(-1) !== "..") kept.pop();
		else if (part !== ".." || !absolute) kept.push(part);
	}
	return kept;
}

function render(device: string, absolute: boolean, parts: readonly string[], trailing: boolean): string {
	const body = parts.join("\\");
	const head = device + (absolute ? "\\" : "");
	if (!body) return head || ".";
	return head + body + (trailing ? "\\" : "");
}

export const win32 = {
	sep: "\\",
	isAbsolute: (input: string): boolean => parse(input).absolute,
	normalize: (input: string): string => {
		const { device, absolute, parts } = parse(input);
		return render(device, absolute, collapse(parts, absolute), input.endsWith("\\") || input.endsWith("/"));
	},
	join: (...inputs: string[]): string => {
		const joined = inputs.filter((input) => input !== "").join("\\");
		return joined ? win32.normalize(joined) : ".";
	},
	resolve: (...inputs: string[]): string => {
		let device = "";
		let absolute = false;
		const parts: string[] = [];
		for (const input of [...inputs].reverse()) {
			if (!input || (device && absolute)) continue;
			const parsed = parse(input);
			if (parsed.device && device && parsed.device.toLowerCase() !== device.toLowerCase()) continue;
			device ||= parsed.device;
			parts.unshift(...parsed.parts);
			absolute ||= parsed.absolute;
		}
		return render(device, absolute, collapse(parts, absolute), false);
	},
	basename: (input: string, extension?: string): string => {
		const name = parse(input).parts.filter(Boolean).at(-1) ?? "";
		return extension && name.endsWith(extension) && name !== extension ? name.slice(0, -extension.length) : name;
	},
};

export const posix = path;
export const { dirname, join } = path;
export default path;
