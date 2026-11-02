import { Type } from "typebox";
import { definePlugin } from "./define.ts";

export const Page = definePlugin("Page", {
	check: { args: Type.Object({ url: Type.String() }), result: Type.Object({ blocked: Type.Optional(Type.String()) }) },
	render: {
		args: Type.Object({ url: Type.String() }),
		result: Type.Object({ html: Type.String(), title: Type.String(), url: Type.String(), ms: Type.Number(), settled: Type.Boolean() }),
	},
});
