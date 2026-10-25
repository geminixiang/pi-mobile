import type { Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { BotExtension } from "./bots.ts";
import type { CalendarAccess } from "./calendar-access.ts";
import { createPhoneCodemode } from "./codemode.ts";
import { createMemoryExtension } from "./memory.ts";
import { createFilesExtension } from "./files/extension.ts";
import { createOnDemandExtension } from "./on-demand.ts";
import { createSandboxExtension, SandboxTools } from "./sandbox/sandbox.ts";
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
import { PhoneScreenExtension } from "./tools/phone-screen.ts";
import { ContactsExtension, PhotosExtension } from "./tools/people.ts";
import { PlacesExtension } from "./tools/places.ts";
import { RecordsExtension, ScreenTimeExtension } from "./tools/records.ts";
import { SpeechExtension } from "./tools/speech.ts";
import { WeatherExtension } from "./tools/weather.ts";
import { createWebExtension, type WebConfig } from "./tools/web.ts";
import { createTriggerExtension, type TriggerHost } from "./triggers.ts";
import type { NativePlugin } from "../native.ts";
import { TOOL_NEEDS, unusableExtensions } from "./toolsets.ts";
import type { Workplace } from "./workplaces.ts";

export interface CatalogDeps {
	native: ReadonlySet<NativePlugin>;
	assistant: Extension;
	calendarAccess: CalendarAccess;
	githubToken?: TokenSource;
	clouds: readonly CloudService[];
	web: WebConfig;
	triggers: TriggerHost;
	memory: { changed(): void };
	workplace: (conversationId: string) => Workplace | undefined;
	labelOf: (extension: string, conversationId: string) => string | undefined;
}

const MODEL_TOOLS = new Set(["codemode", "bash", "read", "write", "edit", "update_memory", "tool_search"]);
const LOADED_TOOLS = new Set(["view_photos", "read_attachment", "read_screen", "use_screen", "read_phone_screen", "use_phone_screen"]);

const TOOL_SEARCH = `Load ${[...LOADED_TOOLS].join(", ")}, the tools whose result is an image you see; they are callable from your next call. Every other tool is offered already or called from codemode scripts: never search for those.`;

function withReach(extension: Extension, native: ReadonlySet<NativePlugin>): Extension {
	const usableTool = (name: string) => {
		const needs = TOOL_NEEDS[name];
		return !needs || native.has(needs);
	};
	return {
		...extension,
		tools: extension.tools?.filter((tool) => usableTool(tool.name)).map((tool) =>
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
		PhoneScreenExtension,
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
		createSandboxExtension(deps.workplace),
		createFilesExtension(deps.workplace),
		createComputerExtension(deps.workplace),
		SandboxTools,
		createToolSearchExtension(),
		createOnDemandExtension(deps.labelOf),
	];
	const unusable = unusableExtensions(deps.native);
	return extensions.filter((extension) => !unusable.has(extension.name)).map((extension) => withReach(extension, deps.native));
}
