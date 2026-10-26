import { Type } from "typebox";
import { definePlugin } from "./define.ts";

export const StreamFetch = definePlugin(
	"StreamFetch",
	{
		start: {
			args: Type.Object({
				url: Type.String(),
				method: Type.String(),
				headers: Type.Record(Type.String(), Type.String()),
				body: Type.Optional(Type.String()),
				bodyBase64: Type.Optional(Type.String()),
			}),
			result: Type.Object({ id: Type.String() }),
		},
		abort: { args: Type.Object({ id: Type.String() }) },
	},
	{
		head: Type.Object({ id: Type.String(), status: Type.Integer(), headers: Type.Record(Type.String(), Type.String()) }),
		chunk: Type.Object({ id: Type.String(), data: Type.String() }),
		end: Type.Object({ id: Type.String() }),
		error: Type.Object({ id: Type.String(), message: Type.String() }),
	},
);
