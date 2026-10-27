import { Type } from "typebox";
import { Granted, definePlugin } from "./define.ts";

export const KeepAlive = definePlugin("KeepAlive", {
	start: { args: Type.Object({ text: Type.String(), title: Type.Optional(Type.String()) }) },
	stop: { args: Type.Object({}) },
	notify: { args: Type.Object({ title: Type.String(), text: Type.String() }) },
	clearNotification: { args: Type.Object({}) },
	status: { args: Type.Object({}), result: Type.Object({ notifications: Type.Boolean(), unrestrictedBattery: Type.Optional(Type.Boolean()) }) },
	requestNotifications: { args: Type.Object({}), result: Granted },
	requestUnrestrictedBattery: { args: Type.Object({}) },
});
