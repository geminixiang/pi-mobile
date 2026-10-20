// Context about the phone the agent runs on: device status, one location fix, and one reading of the environmental
// sensors. Each is read when the tool runs; nothing is tracked in the background.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

interface PhonePlugin {
	getStatus(): Promise<Record<string, unknown>>;
	getLocation(): Promise<Record<string, unknown>>;
	readSensors(): Promise<Record<string, unknown>>;
}

const Phone = registerPlugin<PhonePlugin>("Phone");

const json = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function requireNative(): void {
	if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
}

const deviceInfo = defineTool({
	name: "device_info",
	description:
		"The phone's current state: local time and time zone, language, battery (percent, charging, temperature, power saving), network (Wi-Fi or cellular, metered, VPN), ringer mode and Do Not Disturb, connected headphones, free storage, and model.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		const basics = {
			localTime: new Date().toString(),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			language: navigator.language,
			screen: `${screen.width}x${screen.height} @${devicePixelRatio}x`,
		};
		if (!Capacitor.isNativePlatform()) return json({ ...basics, online: navigator.onLine });
		return json({ ...basics, ...(await Phone.getStatus()) });
	},
});

const getLocation = defineTool({
	name: "get_location",
	description:
		"The phone's current location: latitude, longitude, accuracy, altitude, speed, and the street address. Use it for anything about where the user is or what is nearby, instead of asking them.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		requireNative();
		return json(await Phone.getLocation());
	},
});

const readSensors = defineTool({
	name: "read_sensors",
	description:
		"One reading of the phone's environmental sensors: barometric pressure with an altitude estimate (standard atmosphere, so off by tens of meters with the weather; compare readings for height gained), compass heading and which way the top of the phone faces, ambient light in lux, and proximity (near means something covers the screen, such as a pocket).",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		requireNative();
		return json(await Phone.readSensors());
	},
});

export const DeviceExtension = defineExtension({
	name: "device",
	tools: [deviceInfo, getLocation, readSensors],
	sections: [
		section("device", () =>
			[
				"You run on the user's phone and can read its context: device_info (battery, network, ringer, headphones), get_location (position and address), read_sensors (barometer, compass, light).",
				"Read them when the answer depends on them, such as anything nearby or directions from here, rather than asking the user. They are read once per call; mention briefly what you read.",
			].join("\n"),
		),
	],
});
