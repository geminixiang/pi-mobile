import { Type } from "typebox";
import { definePlugin } from "./define.ts";

export const Loopback = definePlugin(
	"Loopback",
	{
		start: { args: Type.Object({ port: Type.Integer(), path: Type.String() }), result: Type.Object({ port: Type.Integer() }) },
		stop: { args: Type.Object({}) },
	},
	{ redirect: Type.Object({ url: Type.String() }) },
);
