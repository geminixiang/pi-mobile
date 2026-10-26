import { Phone } from "../../plugins/phone.ts";
import { whilePending } from "../../promise.ts";
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { parse } from "../parse.ts";
import { defineAppTool, json, oneOf } from "./common.ts";
import { native } from "../../native.ts";
import { PhoneState } from "../../plugins/phone-state.ts";


const deviceInfo = defineAppTool({
	name: "device_info",
	effect: "read",
	needs: [Phone.getStatus],
	description:
		"The phone's current state: local time and time zone, language, battery (percent, charging, temperature, power saving), network (Wi-Fi or cellular and the Wi-Fi's name, metered, VPN), ringer mode and Do Not Disturb, connected headphones, free storage, and model.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		const basics = {
			localTime: new Date().toString(),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			language: navigator.language,
			screen: `${screen.width}x${screen.height} @${devicePixelRatio}x`,
		};
		const [status, wifiName] = await Promise.all([Phone.getStatus(), native.implements(PhoneState.connections) ? PhoneState.connections().then((state) => state.wifi.name) : undefined]);
		return json({ ...basics, ...status, ...(wifiName ? { wifiName } : {}) });
	},
});

const getLocation = defineAppTool({
	name: "get_location",
	effect: "read",
	needs: [Phone.getLocation],
	description:
		"The phone's current location: latitude, longitude, accuracy, altitude, speed, and the street address. Use it for anything about where the user is or what is nearby, instead of asking them.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		return json(await Phone.getLocation());
	},
});

const readSensors = defineAppTool({
	name: "read_sensors",
	effect: "read",
	needs: [Phone.readSensors],
	description:
		"One reading of the phone's environmental sensors: barometric pressure with an altitude estimate (standard atmosphere, so off by tens of meters with the weather; compare readings for height gained), compass heading and which way the top of the phone faces, ambient light in lux, and proximity (near means something covers the screen, such as a pocket).",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		return json(await Phone.readSensors());
	},
});

export type Point = { latitude: number; longitude: number; label: string };

export function metersBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
	const rad = Math.PI / 180;
	const dLat = (b.latitude - a.latitude) * rad;
	const dLon = (b.longitude - a.longitude) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export async function resolvePlace(place: string): Promise<Point> {
	const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(place);
	if (match) return { latitude: Number(match[1]), longitude: Number(match[2]), label: place.trim() };
	const latitude = /"latitude":\s*(-?\d+(?:\.\d+)?)/.exec(place)?.[1];
	const longitude = /"longitude":\s*(-?\d+(?:\.\d+)?)/.exec(place)?.[1];
	if (latitude && longitude) return { latitude: Number(latitude), longitude: Number(longitude), label: `${latitude},${longitude}` };
	const found = await Phone.geocode({ query: place });
	return { ...found, label: found.address ?? place };
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const FixAddress = Type.Object({
	adminArea: Type.Optional(Type.String()),
	locality: Type.Optional(Type.String()),
	subLocality: Type.Optional(Type.String()),
});

export const currentPlace = whilePending(async (): Promise<Point> => {
	const fix = await Phone.getLocation();
	const latitude = number(fix.latitude);
	const longitude = number(fix.longitude);
	if (latitude === undefined || longitude === undefined) throw new Error("no current location");
	const address = Value.Check(FixAddress, fix.address) ? fix.address : undefined;
	const area = [address?.adminArea, address?.locality, address?.subLocality].filter(Boolean).join("");
	return { latitude, longitude, label: area || "current location" };
});

const OSRM_PROFILES = { driving: "routed-car", walking: "routed-foot", cycling: "routed-bike" } as const;

const OsrmResponse = Type.Object({
	code: Type.String(),
	routes: Type.Optional(Type.Array(Type.Object({ duration: Type.Number(), distance: Type.Number() }))),
});

const travelTime = defineAppTool({
	name: "get_travel_time",
	effect: "read",
	needs: [Phone.getLocation, Phone.geocode],
	description:
		"Route distance and travel time between two places from OpenStreetMap routing (OSRM): driving, walking or cycling. Driving time assumes free-flowing traffic, so add margin at busy hours; there is no public transit. Origin defaults to the phone's current location.",
	parameters: Type.Object({
		destination: Type.String({ description: "Address, place name, or lat,lng" }),
		origin: Type.Optional(Type.String({ description: "Address, place name, or lat,lng; default the current location" })),
		mode: oneOf(["driving", "walking", "cycling"], { description: "How the user goes" }),
	}),
	replay: "safe",
	execute: async (args, _api, context) => {
		const [from, to] = await Promise.all([args.origin ? resolvePlace(args.origin) : currentPlace(), resolvePlace(args.destination)]);
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
});
