import { Type } from "typebox";
import { definePlugin } from "./define.ts";

const Outcome = Type.Union([Type.Object({ ok: Type.Literal(true) }), Type.Object({ ok: Type.Literal(false), reason: Type.String() })]);

export const AgentScreen = definePlugin("AgentScreen", {
	pair: { args: Type.Object({ code: Type.String() }), result: Outcome },
	open: { args: Type.Object({}), result: Type.Union([Type.Object({ ok: Type.Literal(true), display: Type.Integer() }), Type.Object({ ok: Type.Literal(false), reason: Type.String() })]) },
	close: { args: Type.Object({}) },
});
