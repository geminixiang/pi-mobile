import { Type } from "typebox";
import { definePlugin } from "./define.ts";

export const Scanner = definePlugin("Scanner", {
	scan: {
		args: Type.Object({ pages: Type.Optional(Type.Integer()) }),
		result: Type.Union([
			Type.Object({ cancelled: Type.Literal(true) }),
			Type.Object({ cancelled: Type.Literal(false), pdf: Type.String(), pages: Type.Integer() }),
		]),
	},
	ocr: { args: Type.Object({ data: Type.String() }), result: Type.Object({ text: Type.String() }) },
});
