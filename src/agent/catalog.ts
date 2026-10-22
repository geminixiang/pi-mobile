// The built-in extensions, in install order: the one list the runtime installs (runtime.ts) and the tool interface
// check reads (test/tools-node.ts, against test/tools.snapshot.json), so what is checked is what bots get. Extensions
// that need the runtime's connections take them through CatalogDeps; those that need a connection the user has not set
// up are left out (GitHub without a token). The coding tools come with the sandbox when there is one, and otherwise
// with the bot's folder on the phone (files/).
//
// Toolsets that load on demand (toolsets.ts) have their tools marked deferred here.
import type { Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { BotExtension } from "./bots.ts";
import type { CalendarAccess } from "./calendar-access.ts";
import { createPhoneCodemode } from "./codemode.ts";
import { createMemoryExtension } from "./memory.ts";
import { FilesExtension } from "./files/extension.ts";
import { createOnDemandExtension } from "./on-demand.ts";
import { createSandboxExtension, type Sandbox, SandboxTools } from "./sandbox/sandbox.ts";
import { SkillsExtension } from "./skills.ts";
import { ON_DEMAND_EXTENSIONS } from "./toolsets.ts";
import { AppsExtension } from "./tools/apps.ts";
import { AttachmentsExtension } from "./tools/attachments.ts";
import { createCalendarExtension } from "./tools/calendar.ts";
import { type CloudService, createCloudExtensions } from "./tools/cloud.ts";
import { ControlExtension } from "./tools/control.ts";
import { DatabaseExtension } from "./tools/database.ts";
import { DeviceExtension } from "./tools/device.ts";
import { createGitHubExtension, type TokenSource } from "./tools/github.ts";
import { HealthExtension } from "./tools/health.ts";
import { NotificationsExtension } from "./tools/notifications.ts";
import { ContactsExtension, PhotosExtension } from "./tools/people.ts";
import { PlacesExtension } from "./tools/places.ts";
import { RecordsExtension, ScreenTimeExtension } from "./tools/records.ts";
import { SpeechExtension } from "./tools/speech.ts";
import { WeatherExtension } from "./tools/weather.ts";
import { createWebExtension, type WebConfig } from "./tools/web.ts";
import { createTriggerExtension, type TriggerHost } from "./triggers.ts";

export interface CatalogDeps {
	/** The bot's identity and the date: the system prompt's preamble (runtime.ts). */
	assistant: Extension;
	calendarAccess: CalendarAccess;
	/** GitHub's token; without one, no GitHub tools. */
	githubToken?: TokenSource;
	/** The clouds the user connected; one extension each. */
	clouds: readonly CloudService[];
	web: WebConfig;
	triggers: TriggerHost;
	memory: { changed(): void };
	/** The machine or relay the coding tools run on; without one, they work in the bot's folder on the phone. */
	sandbox?: { sandbox: Sandbox; folderOf: (conversationId: string) => string | undefined };
	/** The name a loadable extension goes by in the on-demand list (an MCP server's label, a toolset's). */
	labelOf: (extension: string) => string;
}

/** Deferred tools for the toolsets that load on demand; others as they are. */
function withLoad(extension: Extension): Extension {
	if (!ON_DEMAND_EXTENSIONS.has(extension.name)) return extension;
	return { ...extension, tools: extension.tools?.map((tool) => ({ ...tool, deferred: true as const })) };
}

export function builtinExtensions(deps: CatalogDeps): Extension[] {
	const extensions: Extension[] = [
		deps.assistant,
		BotExtension,
		DeviceExtension,
		WeatherExtension,
		PlacesExtension,
		DatabaseExtension,
		AppsExtension,
		SpeechExtension,
		NotificationsExtension,
		ControlExtension,
		ContactsExtension,
		PhotosExtension,
		RecordsExtension,
		ScreenTimeExtension,
		HealthExtension,
		SkillsExtension,
		AttachmentsExtension,
		createCalendarExtension(deps.calendarAccess),
		...createPhoneCodemode(),
		...(deps.githubToken ? [createGitHubExtension(deps.githubToken)] : []),
		...createCloudExtensions(deps.clouds),
		createWebExtension(deps.web),
		createTriggerExtension(deps.triggers),
		createMemoryExtension(deps.memory),
		...(deps.sandbox ? [createSandboxExtension(deps.sandbox.sandbox, deps.sandbox.folderOf)] : [FilesExtension]),
		SandboxTools,
		createToolSearchExtension(),
		createOnDemandExtension(deps.labelOf),
	];
	return extensions.map(withLoad);
}
