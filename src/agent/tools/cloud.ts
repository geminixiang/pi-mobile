import { Type } from "typebox";
import { CapacitorHttp } from "@capacitor/core";
import { defineExtension } from "@earendil-works/pi-durable";
import { defineAppTool, jsonOrNull, text, truncated } from "./common.ts";
import { jsonOrText, oneOf } from "../parse.ts";

const TIMEOUTS = { connectTimeout: 10_000, readTimeout: 30_000 };

export interface CloudService {
	id: "gcp" | "cloudflare" | "azure";
	tool: string;
	label: string;
	hosts: readonly RegExp[];
	token(host: string): Promise<string>;
	headers?: Record<string, string>;
	base?: string;
	usage: string;
}

const truncate = (value: string) => truncated(value, "; narrow the request with a filter, page size, or fields");

function cloudTool(service: CloudService) {
	return defineAppTool({
		name: service.tool,
		effect: "direct",
		description: [
			`Call the ${service.label} REST API as the user, from the phone (no sandbox needed). ${service.usage}`,
			"Ask for small pages and only the fields you need.",
		].join(" "),
		structuredOutputSchema: Type.Object({ status: Type.Integer(), body: Type.Unknown() }),
		parameters: Type.Object({
			method: oneOf(["GET", "POST", "PUT", "PATCH", "DELETE"]),
			url: Type.String({ description: service.base ? `Full https URL, or a path starting with / under ${service.base}` : "Full https URL" }),
			body: Type.Optional(Type.Unknown({ description: "JSON request body" })),
		}),
		execute: async (args, _api, context) => {
			const url = new URL(args.url.startsWith("/") && service.base ? `${service.base}${args.url}` : args.url);
			if (url.protocol !== "https:" || !service.hosts.some((host) => host.test(url.hostname))) {
				throw new Error(`${service.tool} only calls ${service.label} hosts over https; ${url.hostname} is not one.`);
			}
			const body: unknown = typeof args.body === "string" ? jsonOrText(args.body) : args.body;
			context.abortSignal?.throwIfAborted();
			const token = await service.token(url.hostname);
			const response = await CapacitorHttp.request({
				url: url.toString(),
				method: args.method,
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
			const parsed = raw ? jsonOrText(raw) : null;
			const out = `HTTP ${response.status}\n${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`;
			if (response.status < 200 || response.status >= 300) throw new Error(truncate(out));
			return { ...text(truncate(out)), structuredOutput: { status: response.status, body: jsonOrNull(parsed) } };
		},
	});
}

const AZURE_SCOPES: readonly [RegExp, string][] = [
	[/^management\.azure\.com$/, "https://management.core.windows.net//.default"],
	[/^graph\.microsoft\.com$/, "https://graph.microsoft.com/.default"],
	[/^[a-z0-9-]+\.vault\.azure\.net$/, "https://vault.azure.net/.default"],
	[/^[a-z0-9-]+\.(blob|queue|table|file|dfs)\.core\.windows\.net$/, "https://storage.azure.com/.default"],
];

export function googleService(token: () => Promise<string>, project: string | undefined): CloudService {
	return {
		id: "gcp",
		tool: "gcp_api",
		label: "Google Cloud",
		hosts: [/^[a-z0-9.-]+\.googleapis\.com$/],
		token: () => token(),
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
		id: "cloudflare",
		tool: "cloudflare_api",
		label: "Cloudflare",
		hosts: [/^api\.cloudflare\.com$/],
		base: "https://api.cloudflare.com/client/v4",
		token: () => token(),
		usage: [
			"Paths under /client/v4, e.g. /zones, /accounts/{account_id}/workers/scripts, /graphql (POST, a read: analytics).",
			accountId ? `The account ID is ${accountId}.` : "",
		].join(" "),
	};
}

export function azureService(token: (scope: string) => Promise<string>, subscriptionId: string | undefined): CloudService {
	return {
		id: "azure",
		tool: "azure_api",
		label: "Azure",
		hosts: AZURE_SCOPES.map(([host]) => host),
		token: (host) => {
			const scope = AZURE_SCOPES.find(([pattern]) => pattern.test(host))?.[1];
			if (!scope) throw new Error(`No Azure token for ${host}`);
			return token(scope);
		},
		usage: [
			"https://management.azure.com (ARM; add ?api-version=...), https://graph.microsoft.com, *.vault.azure.net, and storage.",
			"Resource Graph queries (POST .../providers/Microsoft.ResourceGraph/resources) are reads.",
			subscriptionId ? `The default subscription is ${subscriptionId}.` : "",
		].join(" "),
	};
}

export function createCloudExtensions(services: readonly CloudService[]) {
	return services.map((service) =>
		defineExtension({
			name: service.id,
			tools: [cloudTool(service)],
		}),
	);
}
