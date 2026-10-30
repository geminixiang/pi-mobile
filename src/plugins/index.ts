import { Apps } from "./apps.ts";
import { BotFiles } from "./bot-files.ts";
import { Browser } from "../browser/plugin.ts";
import { Calendar } from "./calendar.ts";
import { Contacts } from "./contacts.ts";
import { Database } from "./database.ts";
import { Health } from "./health.ts";
import { KeepAlive } from "./keep-alive.ts";
import { Loopback } from "./loopback.ts";
import { Notifications } from "./notifications.ts";
import { Page } from "./page.ts";
import { Phone } from "./phone.ts";
import { PhoneScreen } from "./phone-screen.ts";
import { PhoneState } from "./phone-state.ts";
import { Photos } from "./photos.ts";
import { Records } from "./records.ts";
import { Scanner } from "./scanner.ts";
import { StreamFetch } from "./stream-fetch.ts";
import { System } from "./system.ts";
import { Triggers } from "./triggers.ts";
import { Usage } from "./usage.ts";
import { Voice } from "./voice.ts";

export const PLUGINS = [
	Apps,
	BotFiles,
	Browser,
	Calendar,
	Contacts,
	Database,
	Health,
	KeepAlive,
	Loopback,
	Notifications,
	Page,
	Phone,
	PhoneScreen,
	PhoneState,
	Photos,
	Records,
	Scanner,
	StreamFetch,
	System,
	Triggers,
	Usage,
	Voice,
] as const;
