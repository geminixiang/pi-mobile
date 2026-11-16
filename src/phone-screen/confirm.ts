import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { actionOf, askBefore, blank, botJudge, type Choice, choose, judgePress, keep, type Outside, OutsideDoc } from "../agent/outside.ts";
import type { PhoneScreenSnapshot, PhoneScreenStep } from "./plugin.ts";

const ID = /^\[(\d+)\] /;
const POINT = / at (\d+),(\d+)/;
const FIELD = "field ";

type Seen = { app: string; lines: ReadonlyMap<number, string> };
type Waits = { at: number; reason: string };

const screens = new Map<number, Seen>();

export function remember(display: number, snapshot: PhoneScreenSnapshot): void {
	if (!snapshot.elements) return;
	const lines = new Map(snapshot.delta ? screens.get(display)?.lines : undefined);
	for (const line of snapshot.elements.split("\n")) {
		if (line.startsWith("gone: ")) for (const id of line.slice("gone: ".length).split(", ")) lines.delete(Number(id.slice(1, -1)));
		const id = ID.exec(line)?.[1];
		if (id) lines.set(Number(id), line);
	}
	screens.set(display, { app: snapshot.app ?? snapshot.package ?? "unknown", lines });
}

export const seenOn = (display: number): Seen => screens.get(display) ?? { app: "unknown", lines: new Map() };

export async function waiting(api: ToolExecutionApi, context: Context, tool: string, display: number, steps: readonly PhoneScreenStep[]): Promise<Waits | undefined> {
	const doc = (await api.snapshot(OutsideDoc, api.conversationId, context)) ?? blank();
	const judge = await botJudge(api, context);
	const seen = seenOn(display);
	const { choices, waits } = await firstWaiting(doc, tool, seen, steps, (control) => judgePress(judge, doc.said, seen.app, control));
	await keep(api, context, choices);
	return waits;
}

export async function firstWaiting(doc: Outside, tool: string, seen: Seen, steps: readonly PhoneScreenStep[], allows: (control: string) => Promise<boolean>): Promise<{ choices: Choice[]; waits?: Waits }> {
	const judged = await Promise.all(
		steps.map(async (step, at) => {
			const press = pressOf(step, seen, steps.slice(0, at));
			if (press === undefined) return undefined;
			const typed = steps.slice(0, at).findLast((earlier) => earlier.action === "type");
			const control = typed?.action === "type" ? `${press} (earlier in these steps it typed "${typed.text}")` : press;
			const held = askBefore(
				`In ${seen.app}, pressing ${control} may send, post or delete something the user did not spell out, so it waits for them; the steps before it ran.`,
				`call ${tool} again with only that step.`,
			);
			return choose(doc, actionOf(tool, { app: seen.app, press: step.action === "key" ? step.key : press }), tool, () => allows(control), held);
		}),
	);
	const at = judged.findIndex((choice) => choice?.gate.allow === false);
	const choices = (at < 0 ? judged : judged.slice(0, at + 1)).filter((choice) => choice !== undefined);
	const stop = judged[at];
	return stop?.gate.allow === false ? { choices, waits: { at, reason: stop.gate.reason } } : { choices };
}

function pressOf(step: PhoneScreenStep, seen: Seen, earlier: readonly PhoneScreenStep[]): string | undefined {
	if (step.action === "key") {
		if (step.key !== "enter") return undefined;
		const field = earlier.map((before) => targetOf(before, seen)).findLast((target) => target !== undefined) ?? [...seen.lines.values()].find((line) => line.includes(" focused"));
		return `the Enter key in ${field ? described(field) : "the focused field"}`;
	}
	const target = targetOf(step, seen);
	return target?.startsWith(FIELD) ? undefined : target;
}

function targetOf(step: PhoneScreenStep, seen: Seen): string | undefined {
	if (step.action === "tap" && "id" in step) return described(seen.lines.get(step.id) ?? `element [${step.id}]`);
	if (step.action === "tap" && "text" in step) return `the control labeled "${step.text}"`;
	if (step.action !== "tap" && step.action !== "long_press") return undefined;
	const near = [...seen.lines.values()].map((line) => ({ line, at: POINT.exec(line) })).sort((a, b) => distance(a.at, step) - distance(b.at, step))[0];
	return near?.at ? described(near.line) : `the point ${step.x},${step.y}`;
}

function described(line: string): string {
	const start = line.replace(ID, "");
	const at = start.search(POINT);
	return at < 0 ? start : start.slice(0, at);
}

function distance(at: RegExpExecArray | null, point: { x: number; y: number }): number {
	return at ? Math.hypot(Number(at[1]) - point.x, Number(at[2]) - point.y) : Number.POSITIVE_INFINITY;
}
