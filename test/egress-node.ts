// End-to-end check of GitHub access from a sandbox through the egress proxy, with this script playing the phone:
// it holds the control channel (sending the token and answering approvals) and runs commands in a throwaway sandbox.
// The only write it lets through is POST /markdown, which renders text and changes nothing; the git push is declined.
// Usage: SANDBOX_TOKEN=... GITHUB_TOKEN=$(gh auth token) node test/egress-node.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { WebSocketConnection } from "../src/agent/sandbox/ws-connection.ts";

const relayUrl = process.env.SANDBOX_RELAY ?? "ws://100.121.187.60:8787";
const relayToken = process.env.SANDBOX_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
if (!relayToken || !githubToken) throw new Error("SANDBOX_TOKEN and GITHUB_TOKEN must be set");

// Answers for successive approval requests: decline, approve, then decline the push.
const answers = [false, true, false];
const asked: string[] = [];
const control = new WebSocket(`${relayUrl}/control?token=${relayToken}`);
await new Promise((resolve, reject) => {
	control.onopen = resolve;
	control.onerror = reject;
});
control.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as { type: string; id: number; title: string; detail: string };
	if (message.type !== "approve") return;
	const approved = answers.shift() ?? false;
	asked.push(`${message.title}${message.detail ? ` [${message.detail}]` : ""} -> ${approved ? "approve" : "decline"}`);
	control.send(JSON.stringify({ type: "approval", id: message.id, approved }));
};
control.send(JSON.stringify({ type: "hello", githubToken }));

const sandbox = "egress-test";
const connection = new WebSocketConnection({ relayUrl, relayToken, sandbox, onLog: (text) => console.error("[log]", text) });
const env = new RemoteExecutionEnv({ connection: connection as unknown as Connection, id: `sandbox:${sandbox}`, cwd: "/workspace" });

async function run(label: string, command: string) {
	let output = "";
	const result = await env.exec(command, { onOutput: (text) => (output += text) }, BACKGROUND_CONTEXT);
	const code = result.ok ? result.value.exitCode : result.error.message;
	console.log(`\n## ${label} (exit ${code})\n${output.trim().slice(0, 600)}`);
}

await run("no real token in the sandbox", "env | grep -iE 'token|proxy' | sed 's/=.*injected.*/=<placeholder>/'; git config --list --show-origin | grep -i cred || echo 'no credential helper'");
await run("gh api user", "gh api user --jq .login");
await run("gh GraphQL read: private repos", "gh repo list --visibility private -L 2 --json nameWithOwner --jq '.[].nameWithOwner'");
await run(
	"git clone a private repo",
	"repo=$(gh repo list --visibility private -L 1 --json nameWithOwner --jq '.[0].nameWithOwner'); rm -rf /tmp/clone && git clone -q --depth 1 https://github.com/$repo /tmp/clone && echo cloned $repo && ls /tmp/clone | head -5",
);
await run("non-GitHub HTTPS passes through", "curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\\n' https://pypi.org/simple/ && pip download -q --no-deps -d /tmp/pip six && echo pip ok");
await run("write, declined", "gh api -X POST /markdown -f text='**hi**'");
await run("write, approved", "gh api -X POST /markdown -f text='**hi**'");
await run(
	"git push, declined",
	"cd /tmp/clone && git checkout -q -b pi-egress-test && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m test && git push origin pi-egress-test 2>&1",
);
console.log("\n## approvals asked\n" + asked.join("\n"));

connection.close();
control.close();
const remove = new URL(`/sandboxes/${sandbox}`, relayUrl.replace(/^ws/, "http"));
remove.searchParams.set("token", relayToken);
await fetch(remove, { method: "DELETE" });
