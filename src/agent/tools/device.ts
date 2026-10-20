// Context about the phone the agent runs on: device status, one location fix, and one reading of the environmental
// sensors. Each is read when the tool runs; nothing is tracked in the background.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { parse } from "../parse.ts";

interface PhonePlugin {
	getStatus(): Promise<Record<string, unknown>>;
	getLocation(): Promise<Record<string, unknown>>;
	readSensors(): Promise<Record<string, unknown>>;
	geocode(options: { query: string }): Promise<{ latitude: number; longitude: number; address?: string }>;
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

type Point = { latitude: number; longitude: number; label: string };

/** "lat,lng" as is; anything else through the phone's geocoder. */
async function resolvePlace(place: string): Promise<Point> {
	const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place);
	if (match) return { latitude: Number(match[1]), longitude: Number(match[2]), label: place.trim() };
	const found = await Phone.geocode({ query: place });
	return { ...found, label: found.address ?? place };
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

// FOSSGIS's public OSRM servers, one per profile. Free and keyless, on fair use (about one request a second).
const OSRM_PROFILES = { driving: "routed-car", walking: "routed-foot", cycling: "routed-bike" } as const;

const OsrmResponse = Type.Object({
	code: Type.String(),
	routes: Type.Optional(Type.Array(Type.Object({ duration: Type.Number(), distance: Type.Number() }))),
});

const travelTime = defineTool({
	name: "get_travel_time",
	description:
		"Route distance and travel time between two places from OpenStreetMap routing (OSRM): driving, walking or cycling. Driving time assumes free-flowing traffic, so add margin at busy hours; there is no public transit. Origin defaults to the phone's current location.",
	parameters: Type.Object({
		destination: Type.String({ description: "Address, place name, or lat,lng" }),
		origin: Type.Optional(Type.String({ description: "Address, place name, or lat,lng; default the current location" })),
		mode: Type.Union([Type.Literal("driving"), Type.Literal("walking"), Type.Literal("cycling")]),
	}),
	replay: "safe",
	execute: async (args, _api, context) => {
		requireNative();
		const here = async (): Promise<Point> => {
			const fix = await Phone.getLocation();
			const latitude = number(fix.latitude);
			const longitude = number(fix.longitude);
			if (latitude === undefined || longitude === undefined) throw new Error("no current location");
			return { latitude, longitude, label: "current location" };
		};
		const [from, to] = await Promise.all([args.origin ? resolvePlace(args.origin) : here(), resolvePlace(args.destination)]);
		const url = `https://routing.openstreetmap.de/${OSRM_PROFILES[args.mode]}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
		const response = await fetch(url, { signal: context.abortSignal });
		if (!response.ok) throw new Error(`routing service: HTTP ${response.status}`);
		const body = parse(OsrmResponse, await response.json(), "routing response");
		const route = body.routes?.[0];
		if (body.code !== "Ok" || !route) throw new Error(`no route found (${body.code})`);
		const seconds = route.duration;
		const meters = route.distance;
		return json({
			mode: args.mode,
			from: from.label,
			to: to.label,
			distanceKm: Math.round(meters / 100) / 10,
			minutes: Math.round(seconds / 60),
			...(args.mode === "driving" ? { note: "free-flow estimate without traffic" } : {}),
		});
	},
});

export const DeviceExtension = defineExtension({
	name: "device",
	tools: [deviceInfo, getLocation, readSensors, travelTime],
	sections: [
		section("device", () =>
			[
				"You run on the user's phone and can read its context: device_info (battery, network, ringer, headphones), get_location (position and address), read_sensors (barometer, compass, light).",
				"Read them when the answer depends on them, such as anything nearby or directions from here, rather than asking the user. They are read once per call; mention briefly what you read.",
				"For how long a trip takes, use get_travel_time instead of guessing. For public transit it has no data: estimate from the walking and driving numbers, say it is an estimate, and offer open_maps for the real schedule.",
			].join("\n"),
		),
	],
});
