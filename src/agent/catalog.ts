// The built-in extensions, in install order: the one list the runtime installs (runtime.ts) and the tool interface
// check reads (test/tools-node.ts, against test/tools.snapshot.json), so what is checked is what bots get. Extensions
// that need the runtime's connections take them through CatalogDeps; those that need a connection the user has not set
// up are left out (GitHub without a token). The coding tools come with the sandbox when there is one, and otherwise
// with the bot's folder on the phone (files/).
//
// How the model reaches each tool is decided here (withReach), so that a request carries few definitions: the model is
// offered code mode, the coding tools, memory, and tool_search; tools whose result it must see as an image are loaded
// with tool_search; every other tool is called from code mode scripts only, listed by name in the codemode section.
import type { Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { BotExtension } from "./bots.ts";
import type { CalendarAccess } from "./calendar-access.ts";
import { createPhoneCodemode } from "./codemode.ts";
import { createMemoryExtension } from "./memory.ts";
import { createFilesExtension } from "./files/extension.ts";
import { createOnDemandExtension } from "./on-demand.ts";
import type { Host } from "./sandbox/host.ts";
import { createSandboxExtension, type Sandbox, SandboxTools } from "./sandbox/sandbox.ts";
import { SkillsExtension } from "./skills.ts";
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
import { createComputerExtension } from "./tools/computer.ts";
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
	/** The computer a bot's coding tools run on; undefined: they work in its folder on the phone. */
	sandbox: { sandboxOf: (conversationId: string) => Sandbox | undefined; folderOf: (conversationId: string) => string | undefined };
	/** The computer whose screen a bot can use; undefined on the phone. */
	hostOf: (conversationId: string) => Host | undefined;
	/** The name a loadable extension goes by in a bot's on-demand list (an MCP server's label, a toolset's); undefined leaves it out. */
	labelOf: (extension: string, conversationId: string) => string | undefined;
}

/** Offered to the model in every request. */
const MODEL_TOOLS = new Set(["codemode", "bash", "read", "write", "edit", "update_memory", "tool_search"]);
/** Their result is an image the model must see, which a script's result leaves out: loaded with tool_search. */
const LOADED_TOOLS = new Set(["view_photos", "read_attachment", "read_screen", "use_screen"]);

/**
 * tool_search searches only the loaded-on-demand tools; its own description says it finds any tool, so weaker models
 * (gpt-6-luna) searched it for bash and for script-only tools, a wasted round each.
 */
const TOOL_SEARCH = `Load ${[...LOADED_TOOLS].join(", ")}, the tools whose result is an image you see; they are callable from your next call. Every other tool is offered already or called from codemode scripts: never search for those.`;

/** Each tool as the model reaches it: offered, loaded on demand, or called from scripts only. */
function withReach(extension: Extension): Extension {
	return {
		...extension,
		tools: extension.tools?.map((tool) =>
			tool.name === "tool_search"
				? { ...tool, description: TOOL_SEARCH }
				: MODEL_TOOLS.has(tool.name)
					? tool
					: LOADED_TOOLS.has(tool.name)
						? { ...tool, deferred: true as const }
						: { ...tool, callers: ["tools"] as const },
		),
	};
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
		...createPhoneCodemode(deps.labelOf),
		...(deps.githubToken ? [createGitHubExtension(deps.githubToken)] : []),
		...createCloudExtensions(deps.clouds),
		createWebExtension(deps.web),
		createTriggerExtension(deps.triggers),
		createMemoryExtension(deps.memory),
		createSandboxExtension(deps.sandbox.sandboxOf, deps.sandbox.folderOf),
		createFilesExtension((id) => !deps.sandbox.sandboxOf(id)),
		createComputerExtension(deps.hostOf),
		SandboxTools,
		createToolSearchExtension(),
		createOnDemandExtension(deps.labelOf),
	];
	return extensions.map(withReach);
}
