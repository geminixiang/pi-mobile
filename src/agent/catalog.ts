import type { ConversationId, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { BotExtension } from "./bots.ts";
import type { CalendarAccess } from "./calendar-access.ts";
import { createPhoneCodemode } from "./codemode.ts";
import { createMemoryExtension } from "./memory.ts";
import { createFilesExtension } from "./files/extension.ts";
import { createOnDemandExtension } from "./on-demand.ts";
import { createSandboxExtension } from "./sandbox/sandbox.ts";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_NOTE, jobsOnComputers } from "../jobs/bash.ts";
import { SkillsExtension } from "./skills.ts";
import { type ActsAsUser, AppsExtension, openScreen } from "./tools/apps.ts";
import { AttachmentsExtension } from "./tools/attachments.ts";
import { createCalendarExtension } from "./tools/calendar.ts";
import { type CloudService, createCloudExtensions } from "./tools/cloud.ts";
import { createControlExtension } from "./tools/control.ts";
import { DatabaseExtension } from "./tools/database.ts";
import { DeviceExtension } from "./tools/device.ts";
import { createGitHubExtension } from "./tools/github.ts";
import { HealthExtension } from "./tools/health.ts";
import { NotificationsExtension } from "./tools/notifications.ts";
import { createComputerExtension } from "./tools/computer.ts";
import { createComputerAgentsExtension } from "../computer-agents/tool.ts";
import { createItemsExtension } from "../items/tool.ts";
import { PhoneScreenExtension } from "../phone-screen/tool.ts";
import { BrowserExtension } from "../browser/tool.ts";
import { ContactsExtension, PhotosExtension } from "./tools/people.ts";
import { PlacesExtension } from "./tools/places.ts";
import { RecordsExtension, ScreenTimeExtension } from "./tools/records.ts";
import { SpeechExtension } from "./tools/speech.ts";
import { TwStocksExtension } from "./tools/tw-stocks.ts";
import { WeatherExtension } from "./tools/weather.ts";
import { createWebExtension, type WebConfig } from "./tools/web.ts";
import { createTriggerExtension, type TriggerHost } from "../triggers/tool.ts";
import { InteractionExtension } from "../interaction/tool.ts";
import type { Native } from "../native.ts";
import { type Groups, usableGroups } from "./toolsets.ts";
import { adopt, declarationOf, gated } from "./tools/common.ts";
import { ToolFilterExtension } from "./tool-filter.ts";
import { type AskForm, permissionGate, type PhonePermissions } from "../interaction/permissions.ts";
import type { Workplace } from "./workplaces.ts";

interface CatalogDeps {
	native: Native;
	userSaid: (id: ConversationId) => Promise<readonly string[]>;
	assistant: Extension;
	calendarAccess: CalendarAccess;
	githubToken?: string;
	clouds: readonly CloudService[];
	web: WebConfig;
	triggers: TriggerHost;
	memory: { changed(): void };
	workplace: (conversationId: string) => Workplace | undefined;
	waitForJob: (conversationId: ConversationId, job: string) => void;
	labelOf: (tool: string, extension: string, conversationId: string) => string | undefined;
	actsAsUser: ActsAsUser;
	permissions: PhonePermissions;
	ask: AskForm;
}

const TOOL_SEARCH =
	"Load a tool listed under \"Load these with tool_search\", the tools whose result is an image you see; it is callable from your next call. Every other tool is offered already or called from codemode scripts: never search for those.";

function toolSearch(): Extension {
	const extension = createToolSearchExtension();
	return { ...extension, tools: (extension.tools ?? []).map((tool) => adopt({ ...tool, description: TOOL_SEARCH }, { groups: "always", effect: "read", needs: [] })) };
}

function groupsOf(tool: ToolRegistration): Groups {
	const declared = declarationOf(tool);
	if (!declared) throw new Error(`${tool.name} has no declaration: define it with defineAppTool or adopt it in catalog.ts`);
	return declared.groups;
}

export function builtinExtensions(deps: CatalogDeps): { extensions: Extension[]; owners: ReadonlyMap<string, Groups> } {
	const bash = createBashTool();
	const jobBash = { ...bash, description: bash.description + BACKGROUND_NOTE, execute: jobsOnComputers(bash.execute, deps.workplace, deps.triggers, deps.waitForJob) };
	const codingTools = (CodingTools.tools ?? []).map((tool) =>
		adopt(tool.name === bash.name ? jobBash : tool, {
			groups: ["files", "computer_shell"],
			effect: "direct",
			needs: [],
		}),
	);
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
		createControlExtension(deps.actsAsUser),
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
		createItemsExtension(deps.triggers),
		createMemoryExtension(deps.memory),
		InteractionExtension,
		createSandboxExtension(deps.workplace),
		createFilesExtension(deps.workplace),
		createComputerExtension(deps.workplace),
		createComputerAgentsExtension(deps.workplace, deps.triggers, deps.userSaid),
		{ ...CodingTools, tools: codingTools },
		toolSearch(),
		createOnDemandExtension(deps.labelOf),
		ToolFilterExtension,
	];
	const installable = (tool: ToolRegistration) =>
		usableGroups(groupsOf(tool), deps.native) && (declarationOf(tool)?.needs ?? []).every((method) => deps.native.implements(method));
	const obtain = permissionGate(deps.permissions, deps.ask);
	const usable = extensions
		.map((extension) => ({ extension, tools: extension.tools?.filter(installable) }))
		.filter(({ tools }) => tools === undefined || tools.length > 0)
		.map(({ extension, tools }) => ({
			...extension,
			tools: tools?.map((tool) => {
				const declared = declarationOf(tool);
				if (declared?.effect === "screen") return gated(tool, (api) => openScreen(deps.actsAsUser, api.conversationId));
				const asks = declared?.asks;
				return asks ? gated(tool, (api, context) => obtain(asks, api, context)) : tool;
			}),
		}));
	return {
		extensions: usable,
		owners: new Map(usable.flatMap((extension) => (extension.tools ?? []).map((tool) => [tool.name, groupsOf(tool)] as const))),
	};
}
