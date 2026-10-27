import { Type } from "typebox";
import { definePlugin } from "./define.ts";

const Photo = Type.Object({
	id: Type.String(),
	name: Type.String(),
	time: Type.Number(),
	album: Type.String(),
	width: Type.Number(),
	height: Type.Number(),
	latitude: Type.Optional(Type.Number()),
	longitude: Type.Optional(Type.Number()),
});

export const Photos = definePlugin("Photos", {
	search: {
		args: Type.Object({ from: Type.Optional(Type.Number()), to: Type.Optional(Type.Number()), album: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer()) }),
		result: Type.Object({ items: Type.Array(Photo) }),
	},
	view: { args: Type.Object({ id: Type.String(), edge: Type.Optional(Type.Integer()) }), result: Type.Object({ data: Type.String(), width: Type.Number(), height: Type.Number() }) },
});
