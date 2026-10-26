import { Type } from "typebox";
import { definePlugin } from "./define.ts";
import { oneOf } from "../agent/tools/common.ts";

export const System = definePlugin("System", {
	openExternal: { args: Type.Object({ url: Type.String() }) },
	haptic: { args: Type.Object({ kind: oneOf(["tick", "press", "confirm"]) }) },
	clipboardText: { args: Type.Object({}), result: Type.Object({ text: Type.String() }) },
	assistant: { args: Type.Object({}), result: Type.Object({ held: Type.Boolean() }) },
	openAssistantSettings: { args: Type.Object({}) },
});
