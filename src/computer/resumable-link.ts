import { Type } from "typebox";
import { decode } from "../parse.ts";

export type RawMessage = ArrayBuffer | string;
export type Link = "up" | "reattaching" | "offline";

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
// why: the computer ends a held session only on a normal closure (1000); a closure without a code, like the reattach after a quiet link, keeps it held.
const NORMAL_CLOSURE = 1000;
const Resume = Type.Object({ received: Type.Integer({ minimum: 0 }) });

export type Budget = { readonly unreachableMs: number; readonly onlineSince: number | undefined };

export type LinkState<S> =
	| { readonly kind: "opening"; readonly heardAt: number }
	| { readonly kind: "up"; readonly socket: S; readonly heardAt: number }
	| { readonly kind: "dialing"; readonly attempt: number; readonly budget: Budget }
	| { readonly kind: "resuming"; readonly attempt: number; readonly budget: Budget; readonly socket: S; readonly heardAt: number }
	| { readonly kind: "waiting"; readonly attempt: number; readonly budget: Budget; readonly delay: number }
	| { readonly kind: "offline"; readonly attempt: number; readonly budget: Budget }
	| { readonly kind: "closed" };

export type Dialing<S> = Extract<LinkState<S>, { kind: "dialing" }>;
type Away<S> = Extract<LinkState<S>, { kind: "waiting" | "offline" }>;
type Dropping<S> = Extract<LinkState<S>, { kind: "up" | "dialing" | "resuming" }>;

export type LinkEvent<S> =
	| { kind: "opened"; socket: S }
	| { kind: "message"; socket: S; data: RawMessage }
	| { kind: "ended"; socket: S; reason: string | undefined }
	| { kind: "quiet" }
	| { kind: "retry" }
	| { kind: "network" }
	| { kind: "dialed"; from: Dialing<S>; socket: S }
	| { kind: "unreachable"; from: Dialing<S> }
	| { kind: "close" };

export type Effect<S> =
	| { kind: "deliver"; data: RawMessage }
	| { kind: "resend"; socket: S; from: number; attempts: number }
	| { kind: "close"; socket: S; code: typeof NORMAL_CLOSURE | undefined }
	| { kind: "dial"; from: Dialing<S> }
	| { kind: "dropped" }
	| { kind: "gave_up"; attempts: number }
	| { kind: "final"; reason: string };

export type World = { now: number; online: boolean; kept: number };
export type Rules = { what: string; quietLimitMs: number; resumeLimitMs: number };
export type Step<S> = { state: LinkState<S>; effects: Effect<S>[] };

const FRESH: Budget = { unreachableMs: 0, onlineSince: undefined };

export function linkOf<S>(state: LinkState<S>): Link | undefined {
	switch (state.kind) {
		case "up":
			return "up";
		case "dialing":
		case "resuming":
		case "waiting":
			return "reattaching";
		case "offline":
			return "offline";
		case "opening":
		case "closed":
			return undefined;
	}
}

export function step<S>(state: LinkState<S>, event: LinkEvent<S>, world: World, rules: Rules): Step<S> {
	const same: Step<S> = { state, effects: [] };
	switch (event.kind) {
		case "opened":
			if (state.kind !== "opening") return { state, effects: [{ kind: "close", socket: event.socket, code: NORMAL_CLOSURE }] };
			return { state: { kind: "up", socket: event.socket, heardAt: state.heardAt }, effects: [] };
		case "message":
			if (state.kind !== "up" && state.kind !== "resuming") return same;
			if (state.socket !== event.socket) return same;
			if (state.kind === "resuming") return resumed(state, event.data, world, rules);
			return { state: { kind: "up", socket: state.socket, heardAt: world.now }, effects: [{ kind: "deliver", data: event.data }] };
		case "ended":
			if (state.kind !== "up" && state.kind !== "resuming") return same;
			if (state.socket !== event.socket) return same;
			return event.reason ? final(state, event.reason) : dropped(state, world);
		case "quiet":
			if (state.kind !== "up" && state.kind !== "resuming") return same;
			if (world.now - state.heardAt <= rules.quietLimitMs) return same;
			return withFirst({ kind: "close", socket: state.socket, code: undefined }, dropped(state, world));
		case "retry":
			return state.kind === "waiting" ? attach(state, state.attempt, world, rules) : same;
		case "network":
			return state.kind === "waiting" || state.kind === "offline" ? attach(state, 0, world, rules) : same;
		case "dialed":
			if (state !== event.from) return { state, effects: [{ kind: "close", socket: event.socket, code: NORMAL_CLOSURE }] };
			return { state: { kind: "resuming", attempt: event.from.attempt, budget: event.from.budget, socket: event.socket, heardAt: world.now }, effects: [] };
		case "unreachable":
			return state === event.from ? dropped(event.from, world) : same;
		case "close":
			return closed(state);
	}
}

function resumed<S>(state: Extract<LinkState<S>, { kind: "resuming" }>, data: RawMessage, world: World, rules: Rules): Step<S> {
	const resume = typeof data === "string" ? decode(Resume, data) : undefined;
	if (!resume) return final(state, `${rules.what} answered the resume with something else`);
	if (resume.received < world.kept) return final(state, `${rules.what} is missing more than this phone kept; the command may still be running there`);
	return {
		state: { kind: "up", socket: state.socket, heardAt: world.now },
		effects: [{ kind: "resend", socket: state.socket, from: resume.received, attempts: state.attempt }],
	};
}

function dropped<S>(state: Dropping<S>, world: World): Step<S> {
	const attempt = state.kind === "up" ? 0 : state.attempt;
	const effects: Effect<S>[] = state.kind === "up" ? [{ kind: "dropped" }] : [];
	const { budget, unreachableMs } = spend(state.kind === "up" ? FRESH : state.budget, world);
	if (unreachableMs === undefined) return { state: { kind: "offline", attempt, budget }, effects };
	const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 15000;
	return { state: { kind: "waiting", attempt, budget, delay }, effects };
}

function attach<S>(state: Away<S>, attempt: number, world: World, rules: Rules): Step<S> {
	const { budget, unreachableMs } = spend(state.budget, world);
	if (unreachableMs === undefined) return { state: { kind: "offline", attempt, budget }, effects: [] };
	if (unreachableMs > rules.resumeLimitMs) {
		return withFirst({ kind: "gave_up", attempts: attempt }, final(state, `could not reach ${rules.what} for ${rules.resumeLimitMs / 60_000} minutes while this phone was online`));
	}
	const dialing: Dialing<S> = { kind: "dialing", attempt: attempt + 1, budget };
	return { state: dialing, effects: [{ kind: "dial", from: dialing }] };
}

function spend(budget: Budget, world: World): { budget: Budget; unreachableMs: number | undefined } {
	if (!world.online) {
		const unreachableMs = budget.onlineSince === undefined ? budget.unreachableMs : budget.unreachableMs + world.now - budget.onlineSince;
		return { budget: { unreachableMs, onlineSince: undefined }, unreachableMs: undefined };
	}
	const onlineSince = budget.onlineSince ?? world.now;
	return { budget: { unreachableMs: budget.unreachableMs, onlineSince }, unreachableMs: budget.unreachableMs + world.now - onlineSince };
}

function closed<S>(state: LinkState<S>): Step<S> {
	if (state.kind === "closed") return { state, effects: [] };
	return { state: { kind: "closed" }, effects: state.kind === "up" || state.kind === "resuming" ? [{ kind: "close", socket: state.socket, code: NORMAL_CLOSURE }] : [] };
}

function final<S>(state: LinkState<S>, reason: string): Step<S> {
	const { state: next, effects } = closed(state);
	return { state: next, effects: [...effects, { kind: "final", reason }] };
}

function withFirst<S>(effect: Effect<S>, rest: Step<S>): Step<S> {
	return { state: rest.state, effects: [effect, ...rest.effects] };
}
