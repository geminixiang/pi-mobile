import { Type } from "typebox";
import { definePlugin } from "./define.ts";

export const Page = definePlugin("Page", {
	render: {
		args: Type.Object({ url: Type.String() }),
		result: Type.Object({ html: Type.String(), title: Type.String(), url: Type.String(), ms: Type.Number(), settled: Type.Boolean() }),
	},
});
