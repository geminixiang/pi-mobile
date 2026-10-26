import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";
import { oneOf } from "../agent/tools/common.ts";

export const STREAMS = ["ring", "media", "alarm", "notification", "call"] as const;
export const RINGERS = ["normal", "vibrate", "silent"] as const;
export type Ringer = (typeof RINGERS)[number];

const SoundState = Type.Object({
	ringer: oneOf(RINGERS),
	volumePercent: Type.Object({ ring: Type.Number(), media: Type.Number(), alarm: Type.Number(), notification: Type.Number(), call: Type.Number() }),
});
export type SoundState = Static<typeof SoundState>;

const DisplayState = Type.Object({
	canChange: Type.Boolean(),
	brightnessPercent: Type.Optional(Type.Number()),
	autoBrightness: Type.Optional(Type.Boolean()),
	autoRotate: Type.Optional(Type.Boolean()),
	screenTimeoutSeconds: Type.Optional(Type.Number()),
});
export type DisplayState = Static<typeof DisplayState>;

export const CONNECTIONS = ["wifi", "bluetooth", "mobile_data", "airplane_mode", "location", "nfc", "battery_saver"] as const;
export type Connection = (typeof CONNECTIONS)[number];

const ConnectionsState = Type.Object({
	wifi: Type.Object({ on: Type.Boolean(), connected: Type.Boolean(), name: Type.Optional(Type.String()) }),
	bluetooth: Type.Object({ on: Type.Boolean(), connectedProfiles: Type.Optional(Type.String()) }),
	mobileData: Type.Object({ on: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("unknown")])) }),
	airplaneMode: Type.Boolean(),
	location: Type.Boolean(),
	nfc: oneOf(["on", "off", "none"]),
	batterySaver: Type.Boolean(),
	outcome: Type.Optional(oneOf(["already", "changed", "pressed", "panel"])),
});
export type ConnectionsState = Static<typeof ConnectionsState>;

const Flashlight = Type.Object({ state: oneOf(["on", "off", "unavailable"]) });

export const PhoneState = definePlugin("PhoneState", {
	sound: { args: Type.Object({}), result: SoundState },
	setRinger: { args: Type.Object({ mode: oneOf(RINGERS) }), result: SoundState },
	setVolume: { args: Type.Object({ stream: oneOf(STREAMS), percent: Type.Number() }), result: SoundState },
	display: { args: Type.Object({}), result: DisplayState },
	setDisplay: {
		args: Type.Object({ what: oneOf(["brightness", "auto_brightness", "auto_rotate", "screen_timeout"]), value: Type.Optional(Type.Number()), on: Type.Optional(Type.Boolean()) }),
		result: DisplayState,
	},
	openWriteSettings: { args: Type.Object({}) },
	flashlight: { args: Type.Object({}), result: Flashlight },
	setFlashlight: { args: Type.Object({ on: Type.Boolean() }), result: Flashlight },
	connections: { args: Type.Object({}), result: ConnectionsState },
	setConnection: { args: Type.Object({ what: oneOf(CONNECTIONS), on: Type.Boolean() }), result: ConnectionsState },
});
