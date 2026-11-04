import { inForeground } from "../app/keepAlive.ts";
import { native } from "../native.ts";
import { Calendar } from "../plugins/calendar.ts";
import { Contacts } from "../plugins/contacts.ts";
import { Phone } from "../plugins/phone.ts";
import { Photos } from "../plugins/photos.ts";
import { Records } from "../plugins/records.ts";
import type { PermissionKind, PermissionState, PhonePermissions } from "./permissions.ts";

const SOURCES = {
	contacts: { plugin: Contacts, aliases: ["contacts"] },
	calendar: { plugin: Calendar, aliases: ["calendar"] },
	photos: { plugin: Photos, aliases: ["photos", "selected"] },
	calls: { plugin: Records, aliases: ["calls"] },
	sms: { plugin: Records, aliases: ["sms"] },
	location: { plugin: Phone, aliases: ["location"] },
} as const;

function stateOf(states: Readonly<Record<string, string>>, aliases: readonly string[]): PermissionState {
	const found = aliases.map((alias) => states[alias]);
	if (found.includes("granted")) return "granted";
	if (found.includes("prompt") || found.includes("prompt-with-rationale")) return "ask";
	return found.includes("denied") ? "denied" : "unknown";
}

export const phonePermissions: PhonePermissions = {
	state: async (kind: PermissionKind) => {
		const { plugin, aliases } = SOURCES[kind];
		if (!native.implements(plugin.checkPermissions)) return "unknown";
		return stateOf(await plugin.checkPermissions({}), aliases);
	},
	request: async (kind: PermissionKind) => {
		const { plugin, aliases } = SOURCES[kind];
		return stateOf(await plugin.requestPermissions({ permissions: [...aliases] }), aliases) === "granted";
	},
	inFront: inForeground,
};
