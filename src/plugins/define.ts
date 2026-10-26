import { Capacitor, type PluginListenerHandle, registerPlugin } from "@capacitor/core";
import { type Static, type TObject, type TSchema, Type } from "typebox";
import { check, parse } from "../agent/parse.ts";
import { log } from "../log.ts";

const PluginHeaders = Type.Array(Type.Object({ name: Type.String(), methods: Type.Array(Type.Object({ name: Type.String() })) }));
const headers = check(PluginHeaders, Reflect.get(Capacitor, "PluginHeaders") ?? [], "Capacitor.PluginHeaders");
if (!headers.ok) log.warn("native.headers_unreadable", { problem: headers.problem });
const implemented = new Map(headers.ok ? headers.value.map((header) => [header.name, new Set(header.methods.map((method) => method.name))]) : []);

export const hasPlugin = (plugin: string): boolean => implemented.has(plugin);

export const isImplemented = ({ plugin, method }: PluginMethod): boolean => implemented.get(plugin)?.has(method) ?? false;

export interface MethodContract {
	readonly args: TObject;
	readonly result?: TSchema;
}

export interface PluginMethod {
	readonly plugin: string;
	readonly method: string;
}

type Args<C extends MethodContract> = {} extends Static<C["args"]> ? [args?: Static<C["args"]>] : [args: Static<C["args"]>];
type Result<C extends MethodContract> = C["result"] extends TSchema ? Static<C["result"]> : void;
type Call<C extends MethodContract> = ((...args: Args<C>) => Promise<Result<C>>) & PluginMethod;

export type Methods = Readonly<Record<string, MethodContract>>;
export type Events = Readonly<Record<string, TSchema>>;

export type NativePlugin<N extends string, M extends Methods, E extends Events> = { readonly [K in keyof M]: Call<M[K]> } & {
	readonly name: N;
	readonly contract: { readonly methods: M; readonly events: E };
	addListener<K extends keyof E & string>(event: K, listener: (data: Static<E[K]>) => void): Promise<PluginListenerHandle>;
};

type Bridge = Record<string, (args: object) => Promise<unknown>> & {
	addListener(event: string, listener: (data: unknown) => void): Promise<PluginListenerHandle>;
};

export function definePlugin<const N extends string, const M extends Methods, const E extends Events = {}>(name: N, methods: M, events?: E): NativePlugin<N, M, E> {
	const bridge = registerPlugin<Bridge>(name);
	const schemas: Events = events ?? {};
	const contract = { methods, events: schemas };
	const calls = Object.entries(methods).map(([method, { result }]) => {
		const call = async (args: object = {}) => {
			if (!isImplemented({ plugin: name, method })) throw new Error(`${name}.${method} is not available on this device`);
			const reply = await bridge[method]?.(args);
			return result ? parse(result, reply, `${name}.${method}`) : undefined;
		};
		return [method, Object.assign(call, { plugin: name, method })];
	});
	const addListener = (event: string, listener: (data: unknown) => void) =>
		bridge.addListener(event, (data) => {
			const checked = check(schemas[event] ?? Type.Unknown(), data, `${name} ${event}`);
			if (checked.ok) listener(checked.value);
			else log.warn("plugin.event_mismatch", { plugin: name, event, problem: checked.problem });
		});
	// why: the methods are built from the contract's keys at runtime, a mapping TypeScript cannot follow from Object.entries.
	return Object.assign(Object.fromEntries(calls), { name, contract, addListener }) as unknown as NativePlugin<N, M, E>;
}
