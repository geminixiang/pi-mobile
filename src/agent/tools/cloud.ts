// Cloud connectors without a sandbox: Google Cloud, Cloudflare, and Azure REST APIs called straight from the phone with
// the credentials signed in under settings. The long-lived credential never leaves the phone and never enters the
// conversation; each request gets a short-lived access token. Which requests are writes (and so need the user's
// approval) follows the sandbox's egress proxy (sandbox/egress/credentials.py), so a call is approved the same way
// whether it comes from a script in the sandbox or from this tool.
import { Type } from "@earendil-works/pi-ai";
import { isJsonValue, type JsonValue } from "@earendil-works/chord";
import { CapacitorHttp } from "@capacitor/core";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { requestConfirmation } from "../confirm.ts";

const MAX_OUTPUT_CHARS = 40_000;
const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 30_000 };

export interface CloudService {
	/** The tool's name, such as gcp_api. */
	tool: string;
	/** Shown in approvals and errors. */
	label: string;
	/** Hosts the tool may call; a token is never sent anywhere else. */
	hosts: readonly RegExp[];
	/** The token for a request to `host`, or why there is none. */
	token(host: string): Promise<string>;
	/** True when the request only reads, so it runs without asking. */
	isRead(method: string, url: URL): boolean;
	/** Extra headers, such as Google's quota project. */
	headers?: Record<string, string>;
	/** Turns a path into a full URL, for services with one API root. */
	base?: string;
	/** One line for the tool description: what the URLs look like. */
	usage: string;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function toJson(value: unknown): JsonValue {
	return isJsonValue(value) ? value : null;
}

function truncate(value: string): string {
	return value.length > MAX_OUTPUT_CHARS
		? `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: ${value.length - MAX_OUTPUT_CHARS} more characters; narrow the request with a filter, page size, or fields]`
		: value;
}

function cloudTool(service: CloudService) {
	return defineTool({
		name: service.tool,
		description: [
			`Call the ${service.label} REST API as the user, from the phone (no sandbox needed). ${service.usage}`,
			"Reads run immediately; writes show the user a confirmation dialog first and fail if they decline.",
			"Ask for small pages and only the fields you need.",
		].join(" "),
		structuredOutputSchema: Type.Object({ status: Type.Integer(), body: Type.Unknown() }),
		parameters: Type.Object({
			method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE")]),
			url: Type.String({ description: service.base ? `Full https URL, or a path starting with / under ${service.base}` : "Full https URL" }),
			body: Type.Optional(Type.Unknown({ description: "JSON request body" })),
			reason: Type.Optional(Type.String({ description: "For writes: one sentence shown to the user in the confirmation dialog" })),
		}),
		execute: async (args, _api, context) => {
			const method: Method = args.method;
			const url = new URL(args.url.startsWith("/") && service.base ? `${service.base}${args.url}` : args.url);
			if (url.protocol !== "https:" || !service.hosts.some((host) => host.test(url.hostname))) {
				throw new Error(`${service.tool} only calls ${service.label} hosts over https; ${url.hostname} is not one.`);
			}
			let body: unknown = args.body;
			// Models sometimes pass the body as a JSON string; send it as the object it encodes.
			if (typeof body === "string") {
				try {
					body = JSON.parse(body);
				} catch {
					// Not JSON: send the string as is.
				}
			}
			if (!service.isRead(method, url)) {
				const approved = await requestConfirmation({
					title: `${service.label} ${method} ${url.hostname}${url.pathname}`,
					detail: [args.reason, body === undefined ? undefined : JSON.stringify(body, null, 2)].filter(Boolean).join("\n\n"),
				});
				if (!approved) {
					throw new Error(
						`The user declined this ${service.label} write. Reply with one short sentence that nothing was done, such as 「好，不做。」; do not list what it would have been, offer alternatives, or ask why.`,
					);
				}
			}
			if (context.abortSignal?.aborted) throw new Error("Aborted");
			const token = await service.token(url.hostname);
			const response = await CapacitorHttp.request({
				url: url.toString(),
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					...service.headers,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { data: body }),
				responseType: "text",
				...TIMEOUTS,
			});
			const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? null);
			let parsed: unknown = raw;
			try {
				parsed = raw ? JSON.parse(raw) : null;
			} catch {
				// Not JSON: returned as text.
			}
			const out = `HTTP ${response.status}\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`;
			if (response.status < 200 || response.status >= 300) throw new Error(truncate(out));
			return { output: [{ type: "text" as const, text: truncate(out) }], structuredOutput: { status: response.status, body: toJson(parsed) } };
		},
	});
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const GOOGLE_READ_VERB = /:(list|search|get|batchGet|getIamPolicy|testIamPermissions|lookup|aggregatedList|fetch\w*)$/;
const AZURE_READ_POST = /(\/providers\/Microsoft\.ResourceGraph\/resources|\/checkNameAvailability|\/\$batch)$/i;
const AZURE_SCOPES: readonly [RegExp, string][] = [
	[/^management\.azure\.com$/, "https://management.core.windows.net//.default"],
	[/^graph\.microsoft\.com$/, "https://graph.microsoft.com/.default"],
	[/^[a-z0-9-]+\.vault\.azure\.net$/, "https://vault.azure.net/.default"],
	[/^[a-z0-9-]+\.(blob|queue|table|file|dfs)\.core\.windows\.net$/, "https://storage.azure.com/.default"],
];

export function googleService(token: () => Promise<string>, project: string | undefined): CloudService {
	return {
		tool: "gcp_api",
		label: "Google Cloud",
		hosts: [/^[a-z0-9.-]+\.googleapis\.com$/],
		token: () => token(),
		isRead: (method, url) => READ_METHODS.has(method) || GOOGLE_READ_VERB.test(url.pathname),
		// A user's sign-in bills API quota to a project only when the request names one.
		...(project ? { headers: { "x-goog-user-project": project } } : {}),
		usage: [
			"Any *.googleapis.com URL, e.g. https://run.googleapis.com/v2/projects/{project}/locations/{region}/services,",
			"https://cloudresourcemanager.googleapis.com/v1/projects, https://logging.googleapis.com/v2/entries:list (POST, a read).",
			project ? `The default project is ${project}.` : "",
		].join(" "),
	};
}

export function cloudflareService(token: () => Promise<string>, accountId: string | undefined): CloudService {
	return {
		tool: "cloudflare_api",
		label: "Cloudflare",
		hosts: [/^api\.cloudflare\.com$/],
		base: "https://api.cloudflare.com/client/v4",
		token: () => token(),
		isRead: (method, url) => READ_METHODS.has(method) || url.pathname === "/client/v4/graphql",
		usage: [
			"Paths under /client/v4, e.g. /zones, /accounts/{account_id}/workers/scripts, /graphql (POST, a read: analytics).",
			accountId ? `The account ID is ${accountId}.` : "",
		].join(" "),
	};
}

export function azureService(token: (scope: string) => Promise<string>, subscriptionId: string | undefined): CloudService {
	return {
		tool: "azure_api",
		label: "Azure",
		hosts: AZURE_SCOPES.map(([host]) => host),
		token: (host) => {
			const scope = AZURE_SCOPES.find(([pattern]) => pattern.test(host))?.[1];
			if (!scope) throw new Error(`No Azure token for ${host}`);
			return token(scope);
		},
		isRead: (method, url) => READ_METHODS.has(method) || (method === "POST" && AZURE_READ_POST.test(url.pathname)),
		usage: [
			"https://management.azure.com (ARM; add ?api-version=...), https://graph.microsoft.com, *.vault.azure.net, and storage.",
			"Resource Graph queries (POST .../providers/Microsoft.ResourceGraph/resources) are reads.",
			subscriptionId ? `The default subscription is ${subscriptionId}.` : "",
		].join(" "),
	};
}

/** The connected services' tools, in one extension; none when nothing is signed in. */
export function createCloudExtension(services: readonly CloudService[]) {
	return defineExtension({
		name: "cloud",
		sections:
			services.length > 0
				? [
						section(
							"cloud",
							() =>
								`Cloud APIs from the phone, no sandbox needed: ${services.map((service) => `${service.tool} (${service.label})`).join(", ")}. Prefer them over the sandbox's CLIs for a quick look; writes need the user's approval.`,
						),
					]
				: [],
		tools: services.map(cloudTool),
	});
}
