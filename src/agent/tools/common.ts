import type { PermissionKind } from "../../interaction/permissions.ts";
import { contentText } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { type Context, isJsonValue, type JsonValue } from "@earendil-works/chord";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { showAlert } from "../../interaction/results.ts";
import { log } from "../../log.ts";
import { gateSend, noteRead, warningOf } from "../outside.ts";
import type { PluginMethod } from "../../plugins/define.ts";
import type { Groups } from "../toolsets.ts";

function unset(value: unknown, schema: unknown): boolean {
	if (value === "" || value === null || (Array.isArray(value) && value.length === 0)) return true;
	if (typeof schema !== "object" || schema === null) return false;
	if (typeof value === "boolean") return Reflect.get(schema, "type") === "string";
	if (value !== 0) return false;
	const minimum = Reflect.get(schema, "minimum");
	const exclusive = Reflect.get(schema, "exclusiveMinimum");
	return (typeof minimum === "number" && minimum > 0) || (typeof exclusive === "number" && exclusive >= 0);
}

function cleaned(parameters: TSchema, raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const properties: unknown = Reflect.get(parameters, "properties");
	const required: unknown = Reflect.get(parameters, "required");
	const needed = new Set(Array.isArray(required) ? required : []);
	const schemaOf = (key: string): unknown => (typeof properties === "object" && properties !== null ? Reflect.get(properties, key) : undefined);
	return Object.fromEntries(
		Object.entries(raw)
			.map(([key, value]) => [key, value, schemaOf(key)] as const)
			.filter(([key, value, schema]) => needed.has(key) || !unset(value, schema))
			.map(([key, value, schema]) => [key, numbered(listed(value, schema), schema)]),
	);
}

function numbered(value: unknown, schema: unknown): unknown {
	if (typeof value !== "string" || value.trim() === "" || typeof schema !== "object" || schema === null) return value;
	const type: unknown = Reflect.get(schema, "type");
	return (type === "integer" || type === "number") && Number.isFinite(Number(value)) ? Number(value) : value;
}

function listed(value: unknown, schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Reflect.get(schema, "type") !== "array") return value;
	const items = Array.isArray(value) ? value : typeof value === "string" || typeof value === "number" ? [value] : undefined;
	if (!items) return value;
	const itemSchema: unknown = Reflect.get(schema, "items");
	const field = soleTextField(itemSchema);
	const wrapped = field ? items.map((item) => (typeof item === "string" ? { [field]: item } : item)) : items;
	return isObjectSchema(itemSchema) ? wrapped.map((item) => cleaned(itemSchema, item)) : wrapped;
}

function isObjectSchema(schema: unknown): schema is TSchema {
	return typeof schema === "object" && schema !== null && Reflect.get(schema, "type") === "object";
}

function soleTextField(schema: unknown): string | undefined {
	if (!isObjectSchema(schema)) return undefined;
	const required: unknown = Reflect.get(schema, "required");
	const properties: unknown = Reflect.get(schema, "properties");
	if (!Array.isArray(required) || required.length !== 1 || typeof properties !== "object" || properties === null) return undefined;
	const [name]: unknown[] = required;
	if (typeof name !== "string") return undefined;
	const property: unknown = Reflect.get(properties, name);
	return typeof property === "object" && property !== null && Reflect.get(property, "type") === "string" ? name : undefined;
}

type Reach = "model" | "loaded" | "script";

export type Effect = "read" | "screen" | "direct";

export interface ToolDeclaration {
	readonly groups: Groups;
	readonly effect: Effect;
	readonly needs: readonly PluginMethod[];
	readonly asks?: PermissionKind;
	readonly outside?: string;
	readonly sends?: true;
}

const REACH = { model: {}, loaded: { deferred: true }, script: { callers: ["tools"] } } as const;

const declarations = new WeakMap<object, ToolDeclaration>();

export const declarationOf = (tool: object): ToolDeclaration | undefined => declarations.get(tool);

export function adopt<Tool extends object>(tool: Tool, declaration: ToolDeclaration): Tool {
	declarations.set(tool, declaration);
	return tool;
}

type AppTool<TParameters extends TSchema, TDetails extends JsonValue> = Omit<ToolRegistration<TParameters, TDetails>, "execute" | "prepareArguments"> & {
	execute(args: Static<TParameters>, api: ToolExecutionApi<TDetails>, context: Context): Promise<ToolExecutionResult<TDetails>>;
};

export function defineAppTool<TParameters extends TSchema, TDetails extends JsonValue = JsonValue>({
	groups,
	reach = "script",
	effect,
	needs = [],
	asks,
	outside,
	sends,
	execute,
	...tool
}: AppTool<TParameters, TDetails> & Omit<ToolDeclaration, "needs"> & { reach?: Reach; needs?: readonly PluginMethod[] }): ToolRegistration<object, TDetails> {
	const registration = defineTool<object, TDetails>({
		...tool,
		...REACH[reach],
		prepareArguments: (raw) => {
			const args = cleaned(tool.parameters, raw);
			if (Value.Check(tool.parameters, args)) return args;
			if (Value.Check(tool.parameters, raw)) return raw;
			const [first] = Value.Errors(tool.parameters, args);
			throw new Error(first ? `${first.instancePath || "arguments"} ${first.message}` : "invalid arguments");
		},
		execute: async (args, api, context) => {
			const started = Date.now();
			log.info("tool.start", { tool: tool.name });
			try {
				if (sends) {
					const gate = await gateSend(api, context, tool.name, args);
					if (!gate.allow) throw new Error(gate.reason);
				}
				const result = await execute(typeboxArgs<TParameters>(args), api, context);
				return outside ? await screened(api, context, tool.name, outside, result) : result;
			} finally {
				log.info("tool.end", { tool: tool.name, ms: Date.now() - started });
			}
		},
	});
	declarations.set(registration, { groups, effect, needs, ...(asks ? { asks } : {}), ...(outside ? { outside } : {}), ...(sends ? { sends } : {}) });
	return registration;
}

function typeboxArgs<TParameters extends TSchema>(args: unknown): Static<TParameters> {
	// why: pi-schema's Static types TypeBox's Enum as unknown; the Harness has checked args against the TypeBox parameters.
	return args as Static<TParameters>;
}

export function gated<TParameters extends TSchema, TDetails extends JsonValue>(
	tool: ToolRegistration<TParameters, TDetails>,
	gate: (api: ToolExecutionApi, context: Context) => Promise<void>,
): ToolRegistration<TParameters, TDetails> {
	const guarded: ToolRegistration<TParameters, TDetails> = {
		...tool,
		execute: async (args, api, context) => {
			await gate(api, context);
			return tool.execute(args, api, context);
		},
	};
	const declaration = declarations.get(tool);
	if (declaration) declarations.set(guarded, declaration);
	return guarded;
}

export const orList = (values: readonly string[]): string => (values.length < 2 ? values.join("") : `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`);

export const text = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });

export const json = (value: unknown): ToolExecutionResult => text(JSON.stringify(value, null, 2));

export const withScreenshot = (facts: string, jpeg: string | undefined, failed: boolean): ToolExecutionResult => ({
	output: [{ type: "text", text: facts }, ...(jpeg ? [{ type: "image" as const, mimeType: "image/jpeg", data: jpeg }] : [])],
	...(failed ? { isError: true } : {}),
});

const MAX_OUTPUT_CHARS = 40_000;

export function truncated(value: string, hint = ""): string {
	return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: ${value.length - MAX_OUTPUT_CHARS} more characters${hint}]` : value;
}

export const jsonOrNull = (value: unknown): JsonValue => (isJsonValue(value) ? value : null);

async function screened<TDetails extends JsonValue>(api: ToolExecutionApi<TDetails>, context: Context, tool: string, source: string, result: ToolExecutionResult<TDetails>): Promise<ToolExecutionResult<TDetails>> {
	const words = contentText(result.output ?? []);
	if (!words) return result;
	const read = await noteRead(api, context, tool, words);
	if (!read) return result;
	if (read.fresh) await showAlert(api, context, source, read.quote);
	return { ...result, output: [{ type: "text", text: warningOf(read) }, ...(result.output ?? [])] };
}

