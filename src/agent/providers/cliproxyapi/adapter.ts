import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { log } from "pi-mobile-base/log";
import { deadline, MINUTE } from "pi-mobile-base/time";
import { checkJson, hostOf } from "../../../parse.ts";
import { randomHex } from "../../../encoding.ts";
import type { Endpoint, EndpointAdapter } from "../route.ts";

const SERVER = "CLI Proxy API Server";
const ROOT_WAIT_MS = 5000;
const CHECK_PROMPT = "You are a terse assistant. Answer in as few words as possible.";

const socketOnly: typeof fetch = () => Promise.reject(new Error(`${SERVER}'s official route is its WebSocket; over HTTP pi takes the plain route`));
const TRANSPORT = { transport: "websocket-cached", fetch: socketOnly } as const;
const ServerRoot = Type.Object({ message: Type.String() });
const codexModule = () => import("@earendil-works/pi-ai/api/openai-codex-responses");

export const cliproxyapi: EndpointAdapter = {
	id: "cliproxyapi",
	recognize: async ({ root }) => {
		const response = await fetch(`${root}/`, { signal: deadline(ROOT_WAIT_MS) });
		const body = response.ok ? checkJson(ServerRoot, await response.text(), "server root") : undefined;
		return body?.ok === true && body.value.message === SERVER;
	},
	adapt: (model, { root }) => official(model, root),
	options: TRANSPORT,
	verify: (endpoint, model) => recalls(endpoint, official(model, endpoint.root)),
};

function official(model: Model<Api>, root: string): Model<"openai-codex-responses"> {
	const { compat: _compat, ...plain } = model;
	return { ...plain, api: "openai-codex-responses", baseUrl: `${root}/backend-api` };
}

async function recalls(endpoint: Endpoint, model: Model<"openai-codex-responses">): Promise<true | string> {
	const codex = await codexModule();
	const sessionId = `route-check-${randomHex(8)}`;
	const word = randomHex(4);
	const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });
	const first = user(`Remember the code word ${word}. Reply with OK only.`);
	const ask = (messages: Message[]) => codex.streamSimple(model, normalizeContext({ systemPrompt: CHECK_PROMPT, messages }), { ...TRANSPORT, apiKey: endpoint.apiKey, sessionId, signal: deadline(MINUTE) }).result();
	try {
		const ok = await ask([first]);
		if (ok.stopReason !== "stop") return `the first check call ended with ${ok.stopReason}: ${ok.errorMessage ?? ""}`;
		const answer = await ask([first, ok, user("What is the code word? Reply with the code word only.")]);
		if (answer.stopReason !== "stop") return `the second check call ended with ${answer.stopReason}: ${answer.errorMessage ?? ""}`;
		if (codex.getOpenAICodexWebSocketDebugStats(sessionId)?.deltaRequests !== 1) return "the second check call did not go out as a delta on the socket";
		if (!textOf(answer).includes(word)) return "the second check call forgot the first: the server drops previous_response_id";
		log.info("models.route_recalled", { host: hostOf(endpoint.root), model: model.id, input: answer.usage.input, cacheRead: answer.usage.cacheRead, cacheWrite: answer.usage.cacheWrite });
		return true;
	} finally {
		codex.closeOpenAICodexWebSocketSessions(sessionId);
		codex.resetOpenAICodexWebSocketDebugStats(sessionId);
	}
}

function textOf(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
