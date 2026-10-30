import type { Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { BotExtension } from "./bots.ts";
import type { CalendarAccess } from "./calendar-access.ts";
import { createPhoneCodemode } from "./codemode.ts";
import { createMemoryExtension } from "./memory.ts";
import { createFilesExtension } from "./files/extension.ts";
import { createOnDemandExtension } from "./on-demand.ts";
import { createSandboxExtension } from "./sandbox/sandbox.ts";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { SkillsExtension } from "./skills.ts";
import { AppsExtension } from "./tools/apps.ts";
import { AttachmentsExtension } from "./tools/attachments.ts";
import { createCalendarExtension } from "./tools/calendar.ts";
import { type CloudService, createCloudExtensions } from "./tools/cloud.ts";
import { ControlExtension } from "./tools/control.ts";
import { DatabaseExtension } from "./tools/database.ts";
import { DeviceExtension } from "./tools/device.ts";
import { createGitHubExtension } from "./tools/github.ts";
import { HealthExtension } from "./tools/health.ts";
import { NotificationsExtension } from "./tools/notifications.ts";
import { createComputerExtension } from "./tools/computer.ts";
import { PhoneScreenExtension } from "../phone-screen/tool.ts";
import { BrowserExtension } from "../browser/tool.ts";
import { ContactsExtension, PhotosExtension } from "./tools/people.ts";
import { PlacesExtension } from "./tools/places.ts";
import { RecordsExtension, ScreenTimeExtension } from "./tools/records.ts";
import { SpeechExtension } from "./tools/speech.ts";
import { TwStocksExtension } from "./tools/tw-stocks.ts";
import { WeatherExtension } from "./tools/weather.ts";
import { createWebExtension, type WebConfig } from "./tools/web.ts";
import { createTriggerExtension, type TriggerHost } from "./triggers.ts";
import type { Native } from "../native.ts";
import { unusableExtensions } from "./toolsets.ts";
import { declarationOf } from "./tools/common.ts";
import type { Workplace } from "./workplaces.ts";

interface CatalogDeps {
	native: Native;
	assistant: Extension;
	calendarAccess: CalendarAccess;
	githubToken?: string;
	clouds: readonly CloudService[];
	web: WebConfig;
	triggers: TriggerHost;
	memory: { changed(): void };
	workplace: (conversationId: string) => Workplace | undefined;
	labelOf: (extension: string, conversationId: string) => string | undefined;
}

const toolSearch = (loaded: readonly string[]) =>
	`Load ${loaded.join(", ")}, the tools whose result is an image you see; they are callable from your next call. Every other tool is offered already or called from codemode scripts: never search for those.`;

export function builtinExtensions(deps: CatalogDeps): { extensions: Extension[]; unsupported: ReadonlySet<string> } {
	const extensions: Extension[] = [
		deps.assistant,
		BotExtension,
		DeviceExtension,
		WeatherExtension,
		PlacesExtension,
		TwStocksExtension,
		DatabaseExtension,
		AppsExtension,
		SpeechExtension,
		NotificationsExtension,
		PhoneScreenExtension,
		BrowserExtension,
		ControlExtension,
		ContactsExtension,
		PhotosExtension,
		RecordsExtension,
		ScreenTimeExtension,
		HealthExtension,
		SkillsExtension,
		AttachmentsExtension,
		createCalendarExtension(deps.calendarAccess),
		createPhoneCodemode(deps.labelOf),
		...(deps.githubToken ? [createGitHubExtension(deps.githubToken)] : []),
		...createCloudExtensions(deps.clouds),
		createWebExtension(deps.web),
		createTriggerExtension(deps.triggers),
		createMemoryExtension(deps.memory),
		createSandboxExtension(deps.workplace),
		createFilesExtension(deps.workplace),
		createComputerExtension(deps.workplace),
		CodingTools,
		createToolSearchExtension(),
		createOnDemandExtension(deps.labelOf),
	];
	const unusable = unusableExtensions(deps.native);
	const filtered = extensions
		.filter((extension) => !unusable.has(extension.name))
		.map((extension) => ({
			...extension,
			tools: extension.tools?.filter((tool) => (declarationOf(tool)?.needs ?? []).every((method) => deps.native.implements(method))),
		}));
	const usable = filtered.filter((extension) => extension.tools === undefined || extension.tools.length > 0);
	const loaded = usable.flatMap((extension) => (extension.tools ?? []).filter((tool) => tool.deferred).map((tool) => tool.name));
	return {
		extensions: usable.map((extension) => ({
			...extension,
			tools: extension.tools?.map((tool) => (tool.name === "tool_search" ? { ...tool, description: toolSearch(loaded) } : tool)),
		})),
		unsupported: new Set(filtered.filter((extension) => extension.tools?.length === 0).map((extension) => extension.name)),
	};
}
