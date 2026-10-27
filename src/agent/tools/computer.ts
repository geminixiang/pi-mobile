import { defineExtension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { McpClient } from "@earendil-works/pi-mcp";
import { mcpResult } from "../mcp.ts";
import { Type } from "typebox";
import { HostStdioTransport, type PairedHost } from "../sandbox/host.ts";
import type { Workplace } from "../workplaces.ts";
import { defineAppTool } from "./common.ts";
import { oneOf } from "../parse.ts";
import { messageOf, sharedUntilFailure } from "../../promise.ts";

const COMMAND = "pi-mobile mcp computer";

const clients = new Map<string, Promise<McpClient>>();

function client(host: PairedHost): Promise<McpClient> {
	return sharedUntilFailure(clients, host.address, async () => {
		const created = new McpClient({ name: "pi-mobile", version: "1.0.0" });
		await created.connect(new HostStdioTransport(host, COMMAND));
		created.onClose(() => clients.delete(host.address));
		return created;
	});
}

async function call(host: PairedHost | undefined, tool: "screenshot" | "act", args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ToolExecutionResult> {
	if (!host) throw new Error("This bot works on the phone: the phone's own screen is read_phone_screen and use_phone_screen; a computer's screen needs a computer picked in the bot's panel.");
	const server = await client(host).catch((error: unknown) => {
		throw new Error(
			`Screen control did not start on ${host.name}: ${messageOf(error)}. pi-mobile there may be older than screen control: tell the user to run the install command on ${host.name} again (Settings › 電腦).`,
		);
	});
	return mcpResult(await server.callTool(tool, args, signal ? { signal } : {}));
}

export function createComputerExtension(workplace: (conversationId: string) => Workplace | undefined) {
	const hostOf = (conversationId: string): PairedHost | undefined => {
		const place = workplace(conversationId);
		return place?.kind === "computer" ? place.host : undefined;
	};
	const readScreen = defineAppTool({
		name: "read_screen",
		effect: "read",
		reach: "loaded",
		description:
			"See the screen of the computer you work on (its desktop, not a container): a screenshot of the main display, and as text its size, the front app, its focused window's title, and the pointer. Coordinates in use_screen are this screenshot's pixels. For what a command cannot reach.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: (_args, api) => call(hostOf(String(api.conversationId)), "screenshot", {}, undefined),
	});
	const useScreen = defineAppTool({
		name: "use_screen",
		effect: "direct",
		reach: "loaded",
		description:
			"Use the computer's mouse and keyboard, then see the result: runs the steps in order and returns the screenshot after them, as read_screen does. " +
			"Put the steps you can already tell in one call (open an app with cmd+space, type its name, return; click a field, type, return); prefer keys to clicks. " +
			"Steps: click {x, y, button: left (default), right, or middle; count: 2 for a double click}; move {x, y}; drag {x, y, to_x, to_y}; " +
			'scroll {x, y, dy and dx in lines, positive down and right}; key {keys: such as "cmd+shift+t", "return", "esc", "down"}; type {text}; wait {ms}.',
		parameters: Type.Object({
			steps: Type.Array(
				Type.Object({
					action: oneOf(["click", "move", "drag", "scroll", "key", "type", "wait"]),
					x: Type.Optional(Type.Number()),
					y: Type.Optional(Type.Number()),
					to_x: Type.Optional(Type.Number()),
					to_y: Type.Optional(Type.Number()),
					button: Type.Optional(oneOf(["left", "right", "middle"])),
					count: Type.Optional(Type.Integer()),
					dx: Type.Optional(Type.Integer()),
					dy: Type.Optional(Type.Integer()),
					keys: Type.Optional(Type.String()),
					text: Type.Optional(Type.String()),
					ms: Type.Optional(Type.Integer()),
				}),
				{ minItems: 1 },
			),
		}),
		execute: (args, api, context) => call(hostOf(String(api.conversationId)), "act", { steps: args.steps }, context.abortSignal),
	});
	return defineExtension({ name: "computer", tools: [readScreen, useScreen] });
}
