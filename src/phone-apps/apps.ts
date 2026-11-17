export type InstalledApp = { package: string; label: string; version: string };

export interface PhoneApps {
	installed(): Promise<readonly InstalledApp[]>;
}

export const NOTE_TOOL = "phone_note_as_user";

const LATIN = /[a-z0-9]/;
const SHORTEST_PREFIX = 2;

type Span = { app: InstalledApp; start: number; end: number };

export function appsIn(said: string, installed: readonly InstalledApp[], limit: number): InstalledApp[] {
	const text = said.toLowerCase();
	const spans = installed.flatMap((app) => namesOf(app).flatMap((name) => spansOf(text, name).map((at) => ({ app, ...at }))));
	const covered = (span: Span) => spans.some((other) => other.app.package !== span.app.package && other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start);
	const best = new Map<string, Span>();
	for (const span of spans.filter((candidate) => !covered(candidate))) {
		const kept = best.get(span.app.package);
		if (!kept || span.end - span.start > kept.end - kept.start) best.set(span.app.package, span);
	}
	return [...best.values()]
		.toSorted((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
		.slice(0, limit)
		.map((span) => span.app);
}

function namesOf(app: InstalledApp): string[] {
	const label = app.label.toLowerCase().trim();
	const words = label.split(" ").flatMap(scriptRuns);
	const prefixes = words.filter((word) => !LATIN.test(word)).flatMap((word) => Array.from({ length: word.length - SHORTEST_PREFIX + 1 }, (_, index) => word.slice(0, SHORTEST_PREFIX + index)));
	const latin = words.filter((word) => LATIN.test(word) && word.length >= 3);
	return [...new Set([label, label.replaceAll(" ", ""), app.package.toLowerCase(), ...latin, ...prefixes])].filter((name) => name.length >= SHORTEST_PREFIX);
}

function scriptRuns(word: string): string[] {
	return [...word].reduce<string[]>((runs, char) => {
		const last = runs.at(-1);
		const same = last !== undefined && LATIN.test(last.at(-1) ?? "") === LATIN.test(char);
		return same ? [...runs.slice(0, -1), last + char] : [...runs, char];
	}, []);
}

function spansOf(text: string, name: string): { start: number; end: number }[] {
	const starts: number[] = [];
	for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) starts.push(at);
	return starts.filter((start) => standsAlone(text, start, name)).map((start) => ({ start, end: start + name.length }));
}

function standsAlone(text: string, start: number, name: string): boolean {
	const before = text[start - 1] ?? "";
	const after = text[start + name.length] ?? "";
	return !(LATIN.test(name[0] ?? "") && LATIN.test(before)) && !(LATIN.test(name.at(-1) ?? "") && LATIN.test(after));
}
