import type { ConversationId, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { BotExtension } from "./bots.ts";
import type { CalendarAccess } from "./calendar-access.ts";
import { createPhoneCodemode } from "./codemode.ts";
import { createMemoryExtension } from "../memory/memory.ts";
import { createFilesExtension } from "./files/extension.ts";
import { createOnDemandExtension } from "./on-demand.ts";
import { createSandboxExtension } from "./sandbox/sandbox.ts";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_NOTE, JOB_BASH_PARAMETERS, jobsOnComputers } from "../jobs/bash.ts";
import { createAppNotes, createSkillsExtension } from "../skills/skills.ts";
import { type ActsAsUser, AppsExtension, openScreen } from "./tools/apps.ts";
import { AttachmentsExtension } from "./tools/attachments.ts";
import { createCalendarExtension } from "./tools/calendar.ts";
import { type CloudService, createCloudExtensions } from "../clouds/tool.ts";
import { createControlExtension } from "../phone-control/tool.ts";
import { DatabaseExtension } from "./tools/database.ts";
import { DeviceExtension } from "../device/tool.ts";
import { createGitHubExtension } from "./tools/github.ts";
import { HealthExtension } from "../health/tool.ts";
import { NotificationsExtension } from "../notifications/tool.ts";
import { createComputerExtension } from "./tools/computer.ts";
import { createComputerAgentsExtension } from "../computer-agents/tool.ts";
import { createItemsExtension } from "../items/tool.ts";
import { PhoneScreenExtension } from "../phone-screen/tool.ts";
import { BrowserExtension } from "../browser/tool.ts";
import { ContactsExtension, PhotosExtension } from "../people/tool.ts";
import { PlacesExtension } from "./tools/places.ts";
import { RecordsExtension, ScreenTimeExtension } from "../records/tool.ts";
import { SpeechExtension } from "../speech/tool.ts";
import { TwStocksExtension } from "./tools/tw-stocks.ts";
import { WeatherExtension } from "../weather/tool.ts";
import { createWebExtension } from "./tools/web.ts";
import type { WebConfig } from "./available-models.ts";
import { createTriggerExtension, type TriggerHost } from "../triggers/tool.ts";
import { InteractionExtension } from "../interaction/tool.ts";
import type { Platform } from "./platform.ts";
import { type Groups, usableGroups } from "./toolsets.ts";
import { adopt, declarationOf, gated, type ToolDeclaration } from "./tools/common.ts";
import { type AskForm, permissionGate } from "./permissions.ts";
import type { Workplace } from "./workplaces.ts";

interface CatalogDeps {
	platform: Pick<Platform, "native" | "permissions" | "apps">;
	userSaid: (id: ConversationId) => Promise<readonly string[]>;
	assistant: Extension;
	calendarAccess: CalendarAccess;
	githubToken?: string;
	clouds: readonly CloudService[];
	web: WebConfig;
	triggers: TriggerHost;
	memory: { changed(): void };
	skills: { changed(): void };
	workplace: (conversationId: string) => Workplace | undefined;
	waitForJob: (conversationId: ConversationId, job: string) => void;
	labelOf: (tool: string, extension: string, conversationId: string) => string | undefined;
	actsAsUser: ActsAsUser;
	ask: AskForm;
}

const TOOL_SEARCH =
	"Load a tool listed under \"Load these with tool_search\", the tools whose result is an image you see; it is callable from your next call. Every other tool is offered already or called from codemode scripts: never search for those.";

function toolSearch(): Extension {
	const extension = createToolSearchExtension();
	return { ...extension, tools: (extension.tools ?? []).map((tool) => adopt({ ...tool, description: TOOL_SEARCH }, { groups: "always", effect: "read", needs: [] })) };
}

function declared(tool: ToolRegistration): ToolDeclaration {
	const declaration = declarationOf(tool);
	if (!declaration) throw new Error(`${tool.name} has no declaration: define it with defineAppTool or adopt it in catalog.ts`);
	return declaration;
}

export function builtinExtensions(deps: CatalogDeps): { extensions: Extension[]; owners: ReadonlyMap<string, Groups> } {
	const bash = createBashTool();
	const jobBash = { ...bash, parameters: JOB_BASH_PARAMETERS, description: bash.description + BACKGROUND_NOTE, execute: jobsOnComputers(bash.execute, deps.workplace, deps.triggers, deps.waitForJob) };
	const codingTools = (CodingTools.tools ?? []).map((tool) =>
		adopt(tool.name === bash.name ? jobBash : tool, {
			groups: ["files", "computer_shell"],
			effect: "direct",
			needs: [],
		}),
	);
	const appNotes = createAppNotes({ unattended: deps.triggers.unattended, apps: deps.platform.apps, actsAsUser: deps.actsAsUser });
	const extensions: Extension[] = [
		appNotes.context,
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
		appNotes.notes,
		BrowserExtension,
		createControlExtension(deps.actsAsUser),
		ContactsExtension,
		PhotosExtension,
		RecordsExtension,
		ScreenTimeExtension,
		HealthExtension,
		createSkillsExtension({ changed: deps.skills.changed, unattended: deps.triggers.unattended }),
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
	];
	const installable = (tool: ToolRegistration) =>
		usableGroups(declared(tool).groups, deps.platform.native) && declared(tool).needs.every((method) => deps.platform.native.implements(method));
	const obtain = permissionGate(deps.platform.permissions, deps.ask);
	const usable = extensions
		.map((extension) => ({ extension, tools: extension.tools?.filter(installable) }))
		.filter(({ tools }) => tools === undefined || tools.length > 0)
		.map(({ extension, tools }) => ({
			...extension,
			tools: tools?.map((tool) => {
				const { effect, asks } = declared(tool);
				if (effect === "screen") return gated(tool, (api) => openScreen(deps.actsAsUser, api.conversationId));
				return asks ? gated(tool, (api, context) => obtain(asks, api, context)) : tool;
			}),
		}));
	return {
		extensions: usable,
		owners: new Map(usable.flatMap((extension) => (extension.tools ?? []).map((tool) => [tool.name, declared(tool).groups] as const))),
	};
}
