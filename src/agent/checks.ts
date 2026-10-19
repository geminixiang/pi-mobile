// Connection checks for the settings screen: each returns a short description of what it reached, or throws.
import { Type } from "typebox";
import { fetchModelIds } from "./models.ts";
import { parse } from "./parse.ts";

const GitHubUser = Type.Object({ login: Type.String() });
const SandboxList = Type.Array(Type.Object({ state: Type.String() }));

const timeout = () => AbortSignal.timeout(8000);

export async function checkModels(baseUrl: string, apiKey: string): Promise<string> {
	const ids = await fetchModelIds(baseUrl, apiKey, timeout());
	return `${ids.length} 個模型`;
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

export async function checkSandbox(url: string, token: string): Promise<string> {
	const list = new URL("/sandboxes", url.replace(/^ws/, "http"));
	list.searchParams.set("token", token);
	const response = await fetch(list, { signal: timeout() });
	if (!response.ok) throw new Error(response.status === 401 ? "token 不正確" : `HTTP ${response.status}`);
	const sandboxes = parse(SandboxList, await response.json(), "sandbox 清單");
	return `${sandboxes.filter((sandbox) => sandbox.state === "running").length} 個執行中 / 共 ${sandboxes.length} 個容器`;
}
