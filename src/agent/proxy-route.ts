import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Message, Model, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { log } from "pi-mobile-base/log";
import { messageOf, orLogged } from "pi-mobile-base/promise";
import { deadline, MINUTE } from "pi-mobile-base/time";
import { checkJson, hostOf } from "../parse.ts";
import { randomHex } from "../encoding.ts";

const PROXY_SERVER = "CLI Proxy API Server";
const ROOT_WAIT_MS = 5000;
const CHECK_PROMPT = "You are a terse assistant. Answer in as few words as possible.";

export type OfficialModel = Model<"openai-codex-responses">;
type Endpoint = { root: string; apiKey: string };
type Route = { kind: "official" } | { kind: "plain"; reason: string };
type Check = { state: "checking"; done: Promise<Route> } | { state: "decided"; route: Route };

const UNCHECKED: Route = { kind: "plain", reason: "not checked yet" };
const checks = new Map<string, Check>();
const keyOf = ({ root, apiKey }: Endpoint) => `${root}\n${apiKey}`;
const plain = (reason: string): Route => ({ kind: "plain", reason });
const codexModule = () => import("@earendil-works/pi-ai/api/openai-codex-responses");

const socketOnly: typeof fetch = () => Promise.reject(new Error(`${PROXY_SERVER}'s official route is its WebSocket; over HTTP pi takes the plain route`));
const OFFICIAL_TRANSPORT = { transport: "websocket-cached", fetch: socketOnly } as const;

export function onOfficialRoute(provider: Provider, root: string, official: (model: Model<Api>) => OfficialModel): Provider {
	const pick = <O extends StreamOptions>(model: Model<Api>, options: O | undefined, run: (model: Model<Api>, options: O | undefined) => AssistantMessageEventStream) => {
		if (!options?.apiKey) return run(model, options);
		const endpoint = { root, apiKey: options.apiKey };
		if (routeNow(endpoint, official(model)).kind === "plain") return run(model, options);
		return officialOrPlain(run(official(model), { ...options, ...OFFICIAL_TRANSPORT }), () => run(model, options), (reason) => forget(endpoint, reason, options.sessionId));
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

function startCheck(endpoint: Endpoint, model: OfficialModel): void {
	const started = Date.now();
	const done = probe(endpoint, model)
		.then(
			(route) => ({ route, lasting: true }),
			(error: unknown) => ({ route: plain(messageOf(error)), lasting: false }),
		)
		.then(({ route, lasting }) => {
			if (lasting) checks.set(keyOf(endpoint), { state: "decided", route });
			else checks.delete(keyOf(endpoint));
			log.info("models.route_checked", { host: hostOf(endpoint.root), route: route.kind, reason: route.kind === "plain" ? route.reason : undefined, lasting, ms: Date.now() - started });
			return route;
		});
	checks.set(keyOf(endpoint), { state: "checking", done });
}

function routeNow(endpoint: Endpoint, model: OfficialModel): Route {
	const known = checks.get(keyOf(endpoint));
	if (known?.state === "decided") return known.route;
	if (!known) startCheck(endpoint, model);
	return UNCHECKED;
}

async function forget(endpoint: Endpoint, reason: string, sessionId: string | undefined): Promise<void> {
	log.warn("models.official_route_failed", { host: hostOf(endpoint.root), reason });
	checks.delete(keyOf(endpoint));
	const codex = await orLogged(codexModule(), "models.codex_module_failed", undefined);
	if (sessionId) codex?.resetOpenAICodexWebSocketDebugStats(sessionId);
}

function officialOrPlain(official: AssistantMessageEventStream, plainStream: () => AssistantMessageEventStream, failed: (reason: string) => Promise<void>): AssistantMessageEventStream {
	const relayed = createAssistantMessageEventStream();
	void orLogged(relay(official, plainStream, failed, relayed), "models.route_relay_failed", undefined).then(() => relayed.end());
	return relayed;
}

async function relay(official: AssistantMessageEventStream, plainStream: () => AssistantMessageEventStream, failed: (reason: string) => Promise<void>, relayed: AssistantMessageEventStream): Promise<void> {
	const events = official[Symbol.asyncIterator]();
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

const ServerRoot = Type.Object({ message: Type.String() });

async function probe(endpoint: Endpoint, model: OfficialModel): Promise<Route> {
	const response = await fetch(`${endpoint.root}/`, { signal: deadline(ROOT_WAIT_MS) });
	const root = response.ok ? checkJson(ServerRoot, await response.text(), "server root") : undefined;
	if (!root?.ok || root.value.message !== PROXY_SERVER) return plain(`not a ${PROXY_SERVER}`);
	return recalls(endpoint, model);
}

async function recalls(endpoint: Endpoint, model: OfficialModel): Promise<Route> {
	const codex = await codexModule();
	const sessionId = `route-check-${randomHex(8)}`;
	const word = randomHex(4);
	const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });
	const first = user(`Remember the code word ${word}. Reply with OK only.`);
	const ask = (messages: Message[]) => codex.streamSimple(model, normalizeContext({ systemPrompt: CHECK_PROMPT, messages }), { ...OFFICIAL_TRANSPORT, apiKey: endpoint.apiKey, sessionId, signal: deadline(MINUTE) }).result();
	try {
		const ok = await ask([first]);
		if (ok.stopReason !== "stop") return plain(`the first check call ended with ${ok.stopReason}: ${ok.errorMessage ?? ""}`);
		const answer = await ask([first, ok, user("What is the code word? Reply with the code word only.")]);
		if (answer.stopReason !== "stop") return plain(`the second check call ended with ${answer.stopReason}: ${answer.errorMessage ?? ""}`);
		if (codex.getOpenAICodexWebSocketDebugStats(sessionId)?.deltaRequests !== 1) return plain("the second check call did not go out as a delta on the socket");
		if (!textOf(answer).includes(word)) return plain("the second check call forgot the first: the server drops previous_response_id");
		log.info("models.route_recalled", { host: hostOf(endpoint.root), model: model.id, input: answer.usage.input, cacheRead: answer.usage.cacheRead, cacheWrite: answer.usage.cacheWrite });
		return { kind: "official" };
	} finally {
		codex.closeOpenAICodexWebSocketSessions(sessionId);
		codex.resetOpenAICodexWebSocketDebugStats(sessionId);
	}
}

function textOf(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
