import { type Static, Type } from "typebox";
import { oneOf } from "../parse.ts";

export const Role = ["button", "field", "checkbox", "switch", "radio", "link", "heading", "text", "list", "item", "image", "slider", "tab", "menu", "window", "group"] as const;
export type Role = (typeof Role)[number];
export const State = ["focused", "selected", "checked", "disabled", "expanded", "scrollable", "password"] as const;
export type State = (typeof State)[number];
export const Key = ["back", "home", "recents", "notifications", "quick_settings", "enter", "tab", "escape", "backspace"] as const;
export type Key = (typeof Key)[number];
export const Action = ["tap", "long_press", "type", "clear", "key", "scroll", "scroll_to", "swipe", "open", "wait", "wait_for", "expect", "hand_over"] as const;
export type Action = (typeof Action)[number];
export const Reason = ["off", "not_set_up", "stale_target", "not_found", "ambiguous", "timeout", "unsupported", "no_focus", "refused", "blocked_by_app", "gated", "interrupted", "display_closed", "expectation_failed"] as const;
export type Reason = (typeof Reason)[number];

type Point = [number, number];
type Direction = "down" | "up" | "left" | "right";
export type Surface = "front" | "background" | { window: string };

const Node = Type.Object({
	ref: Type.String({ minLength: 1 }),
	role: oneOf(Role),
	name: Type.String(),
	value: Type.Optional(Type.String()),
	at: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
	depth: Type.Integer({ minimum: 0 }),
	state: Type.Readonly(Type.Array(oneOf(State))),
	window: Type.Integer({ minimum: 0 }),
});
export type Node = Static<typeof Node>;

export const Observation = Type.Object({
	app: Type.Optional(Type.String()),
	appId: Type.Optional(Type.String()),
	size: Type.Tuple([Type.Number(), Type.Number()]),
	keyboard: Type.Boolean(),
	windows: Type.Array(Type.Object({ kind: oneOf(["app", "system", "sheet", "overlay"]), title: Type.Optional(Type.String()) })),
	nodes: Type.Array(Node),
	truncated: Type.Integer({ minimum: 0 }),
	shot: Type.Optional(Type.Union([Type.Object({ jpeg: Type.String() }), Type.Object({ blocked: oneOf(Reason) })])),
});
export type Observation = Static<typeof Observation>;

export type Target = { ref: string } | { text: string; role?: Role } | { x: number; y: number };
export type Step =
	| { action: "tap" | "long_press"; target: Target }
	| { action: "type"; text: string; target?: Target; submit?: boolean }
	| { action: "clear"; target?: Target }
	| { action: "key"; key: Key }
	| { action: "scroll"; direction: Direction; in?: Target }
	| { action: "scroll_to"; text: string; direction?: Direction }
	| { action: "swipe"; from: Point; to: Point; ms: number }
	| { action: "open"; app: string; link?: string }
	| { action: "wait"; ms: number }
	| { action: "wait_for"; text: string; gone: boolean; ms: number }
	| { action: "expect"; app?: string; text?: string }
	| { action: "hand_over"; reason: string };
export type Outcome = { ok: true; did?: string } | { ok: false; reason: Reason; detail?: string };
export type Capabilities = {
	steps: readonly Action[];
	keys: readonly Key[];
	targets: readonly ("ref" | "text" | "point")[];
	surfaces: readonly ("front" | "background" | "window")[];
	shot: boolean;
	preview: boolean;
};
export interface ScreenDriver {
	capabilities(): Promise<Capabilities>;
	status(): Promise<{ ready: true } | { ready: false; reason: Reason }>;
	observe(surface: Surface, want: { shot: boolean }): Promise<Observation>;
	act(surface: Surface, steps: Step[], want: { shot: boolean }): Promise<{ ran: Outcome[]; after: Observation }>;
}
