import { Type } from "typebox";
import { Allowed, definePlugin } from "./define.ts";

export const Usage = definePlugin("Usage", {
	status: { args: Type.Object({}), result: Allowed },
	openSettings: { args: Type.Object({}) },
	apps: {
		args: Type.Object({ from: Type.Number(), to: Type.Optional(Type.Number()) }),
		result: Type.Object({ items: Type.Array(Type.Object({ package: Type.String(), app: Type.String(), ms: Type.Number() })), unlocks: Type.Number() }),
	},
});
