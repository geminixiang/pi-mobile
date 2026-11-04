import { Type } from "typebox";
import { definePlugin } from "./define.ts";

const Readings = Type.Record(Type.String(), Type.Unknown());

export const Phone = definePlugin("Phone", {
	checkPermissions: { args: Type.Object({}), result: Type.Record(Type.String(), Type.String()) },
	requestPermissions: { args: Type.Object({ permissions: Type.Array(Type.String()) }), result: Type.Record(Type.String(), Type.String()) },
	getStatus: { args: Type.Object({}), result: Readings },
	getLocation: { args: Type.Object({}), result: Readings },
	readSensors: { args: Type.Object({}), result: Readings },
	geocode: {
		args: Type.Object({ query: Type.String() }),
		result: Type.Object({ latitude: Type.Number(), longitude: Type.Number(), address: Type.Optional(Type.String()) }),
	},
});
