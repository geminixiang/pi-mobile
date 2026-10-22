// Connection checks for the settings screen: each returns a short description of what it reached, or throws.
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai";
import { fetchModelIds } from "./models.ts";
import { builtinInfo } from "./providers.ts";
import { memoryCredentials } from "./credentials.ts";
import { chatgptModels, parseOAuthCredential } from "./chatgpt.ts";
import { parse } from "./parse.ts";

const GitHubUser = Type.Object({ login: Type.String() });
const timeout = () => AbortSignal.timeout(8000);

export async function checkModels(baseUrl: string, apiKey: string): Promise<string> {
	const ids = await fetchModelIds(baseUrl, apiKey, timeout());
	return `${ids.length} 個模型`;
}

/**
 * A built-in provider's key: one short request to its cheapest model, the one way that works for every provider.
 * Says which model answered.
 */
export async function checkProvider(id: string, apiKey: string, signIn = ""): Promise<string> {
	const provider = await builtinInfo(id)?.load();
	if (!provider) throw new Error(`unknown provider ${id}`);
	const models = createModels({ credentials: memoryCredentials({ [id]: apiKey }, signIn ? { [id]: signIn } : {}) });
	models.setProvider(provider);
	// Signed in with ChatGPT, only the subscription's models answer.
	const credential = signIn ? parseOAuthCredential(signIn) : undefined;
	const allowed = credential ? await chatgptModels(credential) : undefined;
	const candidates = provider.getModels().filter((candidate) => !allowed || allowed.includes(candidate.id));
	const model = [...candidates].sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0];
	if (!model) throw new Error("no models");
	const reply = await models.complete(
		model,
		{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
		{ maxTokens: 16, signal: AbortSignal.timeout(20_000) },
	);
	if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "error");
	return `${model.name} 有回應`;
}

export async function checkGitHub(token: string): Promise<string> {
	const response = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		signal: timeout(),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const user = parse(GitHubUser, await response.json(), "GitHub /user");
	return `@${user.login}`;
}
