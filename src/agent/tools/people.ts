import { registerPlugin } from "@capacitor/core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";
import { codeNote } from "../codes.ts";
import { DAY, defineAppTool, localTime, parseLocalBound, startOfToday, text } from "./common.ts";
import { metersBetween, resolvePlace } from "./device.ts";

type Contact = {
	name: string;
	starred?: boolean;
	company?: string;
	birthday?: string;
	phones: { number: string; type: string }[];
	emails: string[];
};

type Photo = {
	id: string;
	name: string;
	time: number;
	album: string;
	width: number;
	height: number;
	latitude?: number;
	longitude?: number;
};

const Contacts = registerPlugin<{ search(options: { query?: string }): Promise<{ items: Contact[] }> }>("Contacts");
const Photos = registerPlugin<{
	search(options: { from?: number; to?: number; album?: string; limit?: number }): Promise<{ items: Photo[] }>;
	view(options: { id: string; edge?: number }): Promise<{ data: string; width: number; height: number }>;
}>("Photos");

function daysUntil(birthday: string): number | undefined {
	const match = /(\d{2})-(\d{2})$/.exec(birthday);
	if (!match) return undefined;
	const today = new Date(startOfToday());
	const next = new Date(today.getFullYear(), Number(match[1]) - 1, Number(match[2]));
	if (next < today) next.setFullYear(today.getFullYear() + 1);
	return Math.round((next.getTime() - today.getTime()) / DAY);
}

const contacts = defineAppTool({
	name: "contacts",
	description:
		"Find people in the user's contacts by name, number, email, or company: their numbers, emails, company, birthday. Use it before compose_sms or compose_email when the user names a person. With upcoming_birthdays, only those whose birthday is in the next 30 days, soonest first.",
	parameters: Type.Object({
		query: Type.Optional(Type.String({ description: "Part of a name, number, email, or company" })),
		upcoming_birthdays: Type.Optional(Type.Boolean({ description: "Only people whose birthday is in the next 30 days, soonest first" })),
	}),
	structuredOutputSchema: Type.Object({
		items: Type.Array(
			Type.Object({
				name: Type.String(),
				starred: Type.Optional(Type.Boolean()),
				company: Type.Optional(Type.String()),
				birthday: Type.Optional(Type.String({ description: "YYYY-MM-DD, or --MM-DD without a year" })),
				phones: Type.Array(Type.Object({ number: Type.String(), type: Type.String() })),
				emails: Type.Array(Type.String()),
			}),
		),
	}),
	execute: async (args) => {
		const { items: found } = await Contacts.search({ ...(args.query ? { query: args.query } : {}) });
		const items = args.upcoming_birthdays
			? found
					.map((person) => ({ person, days: person.birthday ? daysUntil(person.birthday) : undefined }))
					.filter((entry): entry is { person: Contact; days: number } => entry.days !== undefined && entry.days <= 30)
					.sort((a, b) => a.days - b.days)
					.map((entry) => entry.person)
			: found;
		const structuredOutput = { items };
		if (items.length === 0) return { ...text(args.query ? `No contact matches "${args.query}".` : "No contacts match."), structuredOutput };
		const lines = items.slice(0, 50).map((person) => {
			const days = person.birthday ? daysUntil(person.birthday) : undefined;
			return [
				`${person.name}${person.starred ? " ★" : ""}${person.company ? `（${person.company}）` : ""}`,
				...person.phones.map((phone) => `  ${phone.type}: ${phone.number}`),
				...person.emails.map((email) => `  email: ${email}`),
				...(person.birthday ? [`  birthday: ${person.birthday}${days !== undefined ? ` (in ${days} days)` : ""}`] : []),
			].join("\n");
		});
		const more = items.length > 50 ? `\n[${items.length - 50} more; narrow the query.]` : "";
		return { ...text(lines.join("\n") + more), structuredOutput };
	},
});

const findPhotos = defineAppTool({
	name: "find_photos",
	description:
		"List the user's photos by when they were taken, where (a place name or lat,lon), and album (Camera, Screenshots, a chat app's folder). Returns ids, times, places, and albums; look at them with view_photos. Use it for 「上週在台南拍的照片」「昨天拍的收據」.",
	parameters: Type.Object({
		from: Type.Optional(Type.String({ description: "Local date or time, such as 2026-10-15 or 2026-10-15 14:00" })),
		to: Type.Optional(Type.String({ description: "Local date or time; a date includes that whole day" })),
		place: Type.Optional(Type.String({ description: "A place name or lat,lon; only photos taken near it" })),
		radius_km: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "With place: how near, in km (default 3)" })),
		album: Type.Optional(Type.String({ description: "Part of the album name, such as Screenshots or Camera" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, description: "At most this many, newest first (default 30)" })),
	}),
	structuredOutputSchema: Type.Object({
		total: Type.Integer({ description: "How many match; items holds the newest limit of them" }),
		items: Type.Array(
			Type.Object({
				id: Type.String(),
				time: Type.String({ description: "Local time taken, YYYY-MM-DD HH:MM" }),
				album: Type.String(),
				latitude: Type.Optional(Type.Number()),
				longitude: Type.Optional(Type.Number()),
				width: Type.Integer(),
				height: Type.Integer(),
			}),
		),
	}),
	execute: async (args) => {
		const center = args.place ? await resolvePlace(args.place) : undefined;
		const limit = args.limit ?? 30;
		const { items } = await Photos.search({
			...(args.from ? { from: parseLocalBound(args.from, "from", false) } : {}),
			...(args.to ? { to: parseLocalBound(args.to, "to", true) } : {}),
			...(args.album ? { album: args.album } : {}),
			limit: center ? 2000 : limit,
		});
		const near = center
			? items.filter((photo) => photo.latitude !== undefined && photo.longitude !== undefined && metersBetween(center, { latitude: photo.latitude, longitude: photo.longitude }) <= (args.radius_km ?? 3) * 1000)
			: items;
		const shown = near.slice(0, limit);
		const structuredOutput = {
			total: near.length,
			items: shown.map((photo) => ({
				id: photo.id,
				time: localTime(photo.time),
				album: photo.album,
				...(photo.latitude !== undefined && photo.longitude !== undefined ? { latitude: photo.latitude, longitude: photo.longitude } : {}),
				width: photo.width,
				height: photo.height,
			})),
		};
		if (shown.length === 0) return { ...text(`No photos match${center ? ` near ${center.label}` : ""}.`), structuredOutput };
		const lines = shown.map(
			(photo) =>
				`${photo.id} · ${localTime(photo.time)} · ${photo.album}${photo.latitude !== undefined ? ` · ${photo.latitude.toFixed(4)},${photo.longitude?.toFixed(4)}` : ""} · ${photo.width}×${photo.height}`,
		);
		return { ...text(`${near.length} photo${near.length === 1 ? "" : "s"}${near.length > shown.length ? `, newest ${shown.length}` : ""}:\n${lines.join("\n")}`), structuredOutput };
	},
});

const MAX_VIEW = 4;

const viewPhotos = defineAppTool({
	name: "view_photos",
	description: `Look at photos by the ids find_photos gave, at most ${MAX_VIEW} a call, scaled down. To show one to the user, describe it; they see it in their gallery.`,
	parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: MAX_VIEW, description: "Photo ids from find_photos" }) }),
	execute: async (args) => {
		const images: ImageContent[] = [];
		for (const id of args.ids) {
			const { data } = await Photos.view({ id });
			images.push({ type: "image", mimeType: "image/jpeg", data });
		}
		const codes = await codeNote(images, (index) => `photo ${args.ids[index]}`);
		return { output: [{ type: "text", text: `Photos ${args.ids.join(", ")}:` }, ...images, ...(codes ? [codes] : [])] };
	},
});

export const ContactsExtension = defineExtension({ name: "contacts", tools: [contacts] });
export const PhotosExtension = defineExtension({ name: "photos", tools: [findPhotos, viewPhotos] });
