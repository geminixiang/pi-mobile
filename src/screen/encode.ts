import type { Node, Observation, Surface } from "./driver.ts";

type Scope = { conversation: string; surface: Surface };
type Ids = { scope: Scope; refs: readonly string[] };
type Line = { id: string; text: string };
type Encoded = { text: string; lines: readonly Line[]; ids: Ids; truncated: number };
const SPACES = /\s+/gu;
const TEXT_CAP = 300;
const RUN_CAP = 25;

export function encode(observation: Observation, scope: Scope, previous?: Ids): Encoded {
	const sameSurface = typeof scope.surface === "string" ? previous?.scope.surface === scope.surface : typeof previous?.scope.surface === "object" && previous.scope.surface.window === scope.surface.window;
	const refs = [...(sameSurface && previous?.scope.conversation === scope.conversation ? previous.refs : [])];
	const lines: Line[] = [{ id: "screen", text: [observation.app ?? observation.appId ?? "screen", observation.app && observation.appId ? `(${observation.appId})` : "", observation.size.join("x"), `keyboard:${observation.keyboard ? "on" : "off"}`, observation.shot && "blocked" in observation.shot ? `shot:${observation.shot.blocked}` : ""].filter(Boolean).join(" ") }];
	const shortened: string[] = [];
	for (const [window, info] of observation.windows.entries()) {
		lines.push({ id: `w${window}`, text: `w${window} ${info.kind}${info.title ? ` ${JSON.stringify(clip(info.title))}` : ""}` });
		if (flat(info.title ?? "").length > TEXT_CAP) shortened.push(`w${window}`);
		const ancestors: { depth: number; ref: string; visible: boolean }[] = [];
		const runs = new Map<string, { role: Node["role"]; count: number }>();
		for (const node of observation.nodes.filter((node) => node.window === window)) {
			while (ancestors.at(-1) && (ancestors.at(-1)?.depth ?? 0) >= node.depth) ancestors.pop();
			const parent = ancestors.at(-1)?.ref ?? "";
			const run = runs.get(parent);
			const count = run?.role === node.role ? run.count + 1 : 1;
			runs.set(parent, { role: node.role, count });
			const wrapper = (node.role === "group" || node.role === "window") && !flat(node.name) && !flat(node.value ?? "") && node.state.length === 0;
			const visible = !wrapper && count <= RUN_CAP;
			const depth = ancestors.filter((ancestor) => ancestor.visible).length;
			ancestors.push({ depth: node.depth, ref: node.ref, visible });
			if (wrapper) continue;
			if (!visible) {
				shortened.push(node.ref);
				continue;
			}
			if (!refs.includes(node.ref)) refs.push(node.ref);
			const id = `e${refs.indexOf(node.ref) + 1}`;
			const name = flat(node.name);
			const value = flat(node.value ?? "");
			if (name.length > TEXT_CAP || value.length > TEXT_CAP) shortened.push(node.ref);
			lines.push({ id, text: `${"  ".repeat(depth)}${id} ${node.role}${name ? ` ${JSON.stringify(clip(name))}` : node.at ? ` @${node.at.join(",")}` : ""}${value ? ` =${JSON.stringify(clip(value))}` : ""}${node.state.length ? ` ${node.state.join(" ")}` : ""}` });
		}
	}
	const truncated = observation.truncated + shortened.length;
	lines.push({ id: "truncated", text: `truncated: ${truncated}` });
	return { text: lines.map((line) => line.text).join("\n"), lines, ids: { scope, refs }, truncated };
}

export function diff(before: Observation, after: Observation, scope: Scope, previous?: Ids): Encoded {
	const was = encode(before, scope, previous);
	const now = encode(after, scope, was.ids);
	const old = new Map(was.lines.map((line) => [line.id, line.text]));
	const changed = now.lines.filter((line) => old.get(line.id) !== line.text);
	const remaining = new Set(after.nodes.map((node) => node.ref));
	const gone = before.nodes.filter((node) => !remaining.has(node.ref)).flatMap((node) => {
		const id = `e${was.ids.refs.indexOf(node.ref) + 1}`;
		return old.has(id) ? [id] : [];
	});
	const windows = was.lines.filter((line) => line.id.startsWith("w") && !now.lines.some((current) => current.id === line.id)).map((line) => line.id);
	const removed = [...gone, ...windows];
	const lines = [...changed, ...(removed.length ? [{ id: "gone", text: `gone: ${removed.join(" ")}` }] : [])];
	return { ...now, lines, text: lines.map((line) => line.text).join("\n") };
}

function flat(text: string): string {
	return text.replace(SPACES, " ").trim();
}

function clip(text: string): string {
	const clean = flat(text);
	return clean.length > TEXT_CAP ? `${clean.slice(0, TEXT_CAP - 1)}…` : clean;
}
