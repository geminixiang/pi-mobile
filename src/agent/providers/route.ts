import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { log } from "pi-mobile-base/log";
import { messageOf, orLogged } from "pi-mobile-base/promise";
import { hostOf } from "../../parse.ts";

export type Endpoint = { root: string; apiKey: string };

export type EndpointAdapter = {
	id: string;
	recognize(endpoint: Endpoint): Promise<boolean>;
	adapt(model: Model<Api>, endpoint: Endpoint): Model<Api>;
	options?: Partial<StreamOptions>;
	verify?(endpoint: Endpoint, model: Model<Api>): Promise<true | string>;
};

type Route = { kind: "adapted"; adapter: EndpointAdapter } | { kind: "plain"; reason: string };
type Check = { state: "checking"; done: Promise<Route> } | { state: "decided"; route: Route };

const UNCHECKED: Route = { kind: "plain", reason: "not checked yet" };
const checks = new Map<string, Check>();
const keyOf = ({ root, apiKey }: Endpoint) => `${root}\n${apiKey}`;
const codexModule = () => import("@earendil-works/pi-ai/api/openai-codex-responses");

export function withAdapters(provider: Provider, root: string, adapters: readonly EndpointAdapter[]): Provider {
	const pick = <O extends StreamOptions>(model: Model<Api>, options: O | undefined, run: (model: Model<Api>, options: O | undefined) => AssistantMessageEventStream) => {
		if (!options?.apiKey) return run(model, options);
		const endpoint = { root, apiKey: options.apiKey };
		const route = routeNow(endpoint, model, adapters);
		if (route.kind === "plain") return run(model, options);
		const adapted = route.adapter.adapt(model, endpoint);
		return adaptedOrPlain(run(adapted, { ...options, ...route.adapter.options }), () => run(model, options), (reason) => forget(endpoint, route.adapter, adapted, reason, options.sessionId));
	};
	const wrapped: Provider = Object.create(provider);
	return Object.defineProperties(wrapped, {
		stream: { value: (model: Model<Api>, context: Parameters<Provider["stream"]>[1], options?: Parameters<Provider["stream"]>[2]) => pick(model, options, (chosen, chosenOptions) => provider.stream(chosen, context, chosenOptions)) },
		streamSimple: { value: (model: Model<Api>, context: Parameters<Provider["streamSimple"]>[1], options?: Parameters<Provider["streamSimple"]>[2]) => pick(model, options, (chosen, chosenOptions) => provider.streamSimple(chosen, context, chosenOptions)) },
	});
}

export function checkedRoute(endpoint: Endpoint): Promise<Route> {
	const known = checks.get(keyOf(endpoint));
	if (!known) return Promise.resolve(UNCHECKED);
	return known.state === "checking" ? known.done : Promise.resolve(known.route);
}

function routeNow(endpoint: Endpoint, model: Model<Api>, adapters: readonly EndpointAdapter[]): Route {
	const known = checks.get(keyOf(endpoint));
	if (known?.state === "decided") return known.route;
	if (!known) startCheck(endpoint, model, adapters);
	return UNCHECKED;
}

function startCheck(endpoint: Endpoint, model: Model<Api>, adapters: readonly EndpointAdapter[]): void {
	const started = Date.now();
	const done = decide(endpoint, model, adapters)
		.then(
			(route) => ({ route, lasting: true }),
			(error: unknown): { route: Route; lasting: boolean } => ({ route: { kind: "plain", reason: messageOf(error) }, lasting: false }),
		)
		.then(({ route, lasting }) => {
			if (lasting) checks.set(keyOf(endpoint), { state: "decided", route });
			else checks.delete(keyOf(endpoint));
			const outcome = route.kind === "adapted" ? { adapter: route.adapter.id } : { reason: route.reason };
			log.info("models.route_checked", { host: hostOf(endpoint.root), route: route.kind, ...outcome, lasting, ms: Date.now() - started });
			return route;
		});
	checks.set(keyOf(endpoint), { state: "checking", done });
}

async function decide(endpoint: Endpoint, model: Model<Api>, adapters: readonly EndpointAdapter[]): Promise<Route> {
	const refusals: string[] = [];
	for (const adapter of adapters) {
		if (!(await adapter.recognize(endpoint))) continue;
		const verdict = (await adapter.verify?.(endpoint, model)) ?? true;
		if (verdict === true) return { kind: "adapted", adapter };
		refusals.push(`${adapter.id}: ${verdict}`);
	}
	return { kind: "plain", reason: refusals.length === 0 ? "no adapter recognizes it" : refusals.join("; ") };
}

async function forget(endpoint: Endpoint, adapter: EndpointAdapter, adapted: Model<Api>, reason: string, sessionId: string | undefined): Promise<void> {
	log.warn("models.adapter_failed", { host: hostOf(endpoint.root), adapter: adapter.id, reason });
	checks.delete(keyOf(endpoint));
	if (!sessionId || adapted.api !== "openai-codex-responses") return;
	const codex = await orLogged(codexModule(), "models.codex_module_failed", undefined);
	codex?.resetOpenAICodexWebSocketDebugStats(sessionId);
}

function adaptedOrPlain(adapted: AssistantMessageEventStream, plainStream: () => AssistantMessageEventStream, failed: (reason: string) => Promise<void>): AssistantMessageEventStream {
	const relayed = createAssistantMessageEventStream();
	void orLogged(relay(adapted, plainStream, failed, relayed), "models.route_relay_failed", undefined).then(() => relayed.end());
	return relayed;
}

async function relay(adapted: AssistantMessageEventStream, plainStream: () => AssistantMessageEventStream, failed: (reason: string) => Promise<void>, relayed: AssistantMessageEventStream): Promise<void> {
	const events = adapted[Symbol.asyncIterator]();
	const first = await events.next();
	if (first.done) return;
	if (refused(first.value)) {
		await failed(first.value.error.errorMessage ?? "no message");
		for await (const event of plainStream()) relayed.push(event);
		return;
	}
	relayed.push(first.value);
	for await (const event of { [Symbol.asyncIterator]: () => events }) relayed.push(event);
}

function refused(event: AssistantMessageEvent): event is Extract<AssistantMessageEvent, { type: "error" }> {
	return event.type === "error" && event.reason === "error";
}
