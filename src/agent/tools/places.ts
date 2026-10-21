// find_places: shops, restaurants, and services near a place or the phone, from OpenStreetMap. Photon (komoot's OSM
// search) finds them, by category (the nearest of a tag, such as amenity:fuel) or by name; Nominatim then adds what a
// search result lacks (opening hours, phone, branch, website), for all results in one request. Both are free and
// keyless on fair use; the public Overpass servers are not used, as they are for people, not apps, and often full.
// OSM has no ratings or reviews: the section points the model to web_search for which one is good.
import { CapacitorHttp } from "@capacitor/core";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { parse, parseJson } from "../parse.ts";
import { currentPlace, type Point, resolvePlace } from "./device.ts";

// Nominatim's usage policy asks apps to identify themselves; native HTTP can set the header, the WebView cannot.
const HEADERS = { "User-Agent": "pi-mobile (+https://github.com/geminixiang/pi-mobile)", Accept: "application/json" };
const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 20_000 };

async function getJson(url: string, what: string): Promise<unknown> {
	const response = await CapacitorHttp.get({ url, headers: HEADERS, ...TIMEOUTS });
	if (response.status !== 200) throw new Error(`${what}: HTTP ${response.status}`);
	return typeof response.data === "string" ? parseJson(response.data, what) : response.data;
}

const PhotonResults = Type.Object({
	features: Type.Array(
		Type.Object({
			geometry: Type.Object({ coordinates: Type.Array(Type.Number()) }),
			properties: Type.Object({
				osm_type: Type.String(),
				osm_id: Type.Number(),
				osm_key: Type.String(),
				osm_value: Type.String(),
				name: Type.Optional(Type.String()),
				housenumber: Type.Optional(Type.String()),
				street: Type.Optional(Type.String()),
				district: Type.Optional(Type.String()),
				city: Type.Optional(Type.String()),
				countrycode: Type.Optional(Type.String()),
			}),
		}),
	),
});

const NominatimDetails = Type.Array(
	Type.Object({ osm_type: Type.String(), osm_id: Type.Number(), extratags: Type.Optional(Type.Record(Type.String(), Type.String())) }),
);

/** The extra tags worth showing, by OSM key. */
const DETAILS = ["branch", "opening_hours", "phone", "contact:phone", "website", "contact:website", "cuisine", "brand"] as const;

const Place = Type.Object({
	name: Type.String(),
	category: Type.String(),
	address: Type.String(),
	distanceM: Type.Number(),
	direction: Type.String(),
	latitude: Type.Number(),
	longitude: Type.Number(),
	branch: Type.Optional(Type.String()),
	openingHours: Type.Optional(Type.String()),
	phone: Type.Optional(Type.String()),
	website: Type.Optional(Type.String()),
	cuisine: Type.Optional(Type.String()),
});

/** Great-circle distance in meters. */
function distance(a: Point, latitude: number, longitude: number): number {
	const rad = Math.PI / 180;
	const dLat = (latitude - a.latitude) * rad;
	const dLon = (longitude - a.longitude) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(latitude * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Compass direction from `a`, in eight steps. */
function direction(a: Point, latitude: number, longitude: number): string {
	const y = (longitude - a.longitude) * Math.cos(a.latitude * (Math.PI / 180));
	const x = latitude - a.latitude;
	const degrees = (Math.atan2(y, x) * 180) / Math.PI;
	return ["北", "東北", "東", "東南", "南", "西南", "西", "西北"][Math.round(((degrees + 360) % 360) / 45) % 8] ?? "";
}

function localNow(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	const day = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][now.getDay()];
	return `${day} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const findPlaces = defineTool({
	name: "find_places",
	description: [
		"Find shops, restaurants, and services near a place or the phone, from OpenStreetMap, nearest first: name, branch, category, address, straight-line distance and direction, and when known opening hours (OSM syntax), phone, website, and cuisine.",
		"By category: an OSM tag as key:value, such as amenity:fuel, amenity:cafe, amenity:restaurant, amenity:pharmacy, amenity:hospital, amenity:atm, amenity:parking, amenity:toilets, amenity:charging_station, shop:convenience, shop:supermarket, tourism:hotel. By name: query, such as 鼎泰豐 or 全聯.",
		"OSM has no ratings or reviews, and small or new places may be missing.",
	].join(" "),
	parameters: Type.Object({
		category: Type.Optional(Type.String({ description: "OSM tag key:value, such as amenity:fuel" })),
		query: Type.Optional(Type.String({ description: "A name or brand, such as 鼎泰豐" })),
		near: Type.Optional(Type.String({ description: "Place name, address, or lat,lng to search around; default the phone's location" })),
		radiusKm: Type.Optional(Type.Number({ description: "For a category: how far to look; default 1" })),
		limit: Type.Optional(Type.Integer({ description: "How many; default 20, up to 50" })),
	}),
	structuredOutputSchema: Type.Object({ near: Type.String(), now: Type.String(), places: Type.Array(Place) }),
	replay: "safe",
	execute: async (args) => {
		if (!args.category && !args.query) throw new Error("give a category (an OSM tag such as amenity:fuel) or a query (a name)");
		const center = args.near ? await resolvePlace(args.near) : await currentPlace();
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
		const query = new URLSearchParams({ lat: String(center.latitude), lon: String(center.longitude), limit: String(limit) });
		if (args.category) query.set("osm_tag", args.category.replace("=", ":"));
		let url: string;
		if (args.query) {
			query.set("q", args.query);
			url = `https://photon.komoot.io/api/?${query}`;
		} else {
			// Reverse geocoding with a tag filter: the nearest places of that kind within the radius.
			query.set("radius", String(Math.min(Math.max(args.radiusKm ?? 1, 0.1), 50)));
			url = `https://photon.komoot.io/reverse?${query}`;
		}
		const found = parse(PhotonResults, await getJson(url, "place search"), "place search").features.filter((feature) => feature.properties.name);

		// One Nominatim request for all results' details; without it the places are still useful.
		const ids = found.map((feature) => `${feature.properties.osm_type}${feature.properties.osm_id}`);
		const details = new Map<string, Record<string, string>>();
		if (ids.length > 0) {
			try {
				const body = await getJson(`https://nominatim.openstreetmap.org/lookup?osm_ids=${ids.join(",")}&format=jsonv2&extratags=1&addressdetails=0`, "place details");
				if (Value.Check(NominatimDetails, body)) {
					for (const item of body) details.set(`${item.osm_type[0]?.toUpperCase()}${item.osm_id}`, item.extratags ?? {});
				}
			} catch {
				// Details are extra.
			}
		}

		const places = found
			.map((feature) => {
				const p = feature.properties;
				const [longitude = 0, latitude = 0] = feature.geometry.coordinates;
				const tags = details.get(`${p.osm_type}${p.osm_id}`) ?? {};
				const pick = (...keys: (typeof DETAILS)[number][]) => keys.map((key) => tags[key]).find(Boolean);
				const address = [p.city, p.district, p.street, p.housenumber ? `${p.housenumber}號` : undefined].filter(Boolean).join("");
				const branch = pick("branch");
				const openingHours = pick("opening_hours");
				const phone = pick("phone", "contact:phone");
				const website = pick("website", "contact:website");
				const cuisine = pick("cuisine");
				return {
					name: p.name ?? "",
					category: `${p.osm_key}:${p.osm_value}`,
					address,
					distanceM: Math.round(distance(center, latitude, longitude)),
					direction: direction(center, latitude, longitude),
					latitude,
					longitude,
					...(branch ? { branch } : {}),
					...(openingHours ? { openingHours } : {}),
					...(phone ? { phone } : {}),
					...(website ? { website } : {}),
					...(cuisine ? { cuisine } : {}),
				};
			})
			.sort((a, b) => a.distanceM - b.distanceM);

		const now = localNow();
		const lines = places.map((place) =>
			[
				`${place.name}${place.branch ? `（${place.branch}）` : ""}`,
				place.category,
				`${place.distanceM} m ${place.direction}`,
				place.address,
				place.openingHours && `hours ${place.openingHours}`,
				place.phone,
				place.website,
				place.cuisine && `cuisine ${place.cuisine}`,
				`${place.latitude.toFixed(5)},${place.longitude.toFixed(5)}`,
			]
				.filter(Boolean)
				.join(" · "),
		);
		const text =
			places.length > 0
				? [`Near ${center.label}; now ${now}. Distances are straight-line.`, ...lines].join("\n")
				: `Nothing found near ${center.label}${args.category ? ` for ${args.category}` : ""}${args.query ? ` named ${args.query}` : ""}. Try a wider radius or another tag.`;
		return { output: [{ type: "text", text }], structuredOutput: { near: center.label, now, places } };
	},
});

export const PlacesExtension = defineExtension({
	name: "places",
	tools: [findPlaces],
	sections: [
		section("places", () =>
			[
				"Places nearby or by name: find_places (OpenStreetMap). Its distances are straight-line: for the closest few, get_travel_time gives the real time; open_maps navigates.",
				"OSM has no ratings: when the user wants a good one, check the candidates with web_search. Opening hours are in OSM syntax; judge open now from the time it gives, and say when hours are unknown.",
			].join("\n"),
		),
	],
});
