// End-to-end check of cf and wrangler in a sandbox through the egress proxy, with this script playing the phone: it answers
// the relay's token requests with CLOUDFLARE_TOKEN and declines every write. The only write it attempts deletes a Worker
// that does not exist, so nothing changes even if it went through.
// Usage: SANDBOX_RELAY=ws://<host>:8787 SANDBOX_TOKEN=... CLOUDFLARE_TOKEN=<access token> \
//        CLOUDFLARE_ACCOUNT=<account id> node test/cloudflare-node.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { WebSocketConnection } from "../src/agent/sandbox/ws-connection.ts";

const relayUrl = process.env.SANDBOX_RELAY ?? "ws://127.0.0.1:8787";
const relayToken = process.env.SANDBOX_TOKEN;
const cloudflareToken = process.env.CLOUDFLARE_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT ?? "";
if (!relayToken || !cloudflareToken) throw new Error("SANDBOX_TOKEN and CLOUDFLARE_TOKEN must be set");

const asked: string[] = [];
let tokenRequests = 0;
const control = new WebSocket(`${relayUrl}/control?token=${relayToken}`);
await new Promise((resolve, reject) => {
	control.onopen = resolve;
	control.onerror = reject;
});
control.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as { type: string; id: number; title: string; detail: string };
	if (message.type === "token") {
		tokenRequests++;
		control.send(JSON.stringify({ type: "token", service: "cloudflare", token: cloudflareToken, expiresAt: Date.now() + 30 * 60_000 }));
	} else if (message.type === "approve") {
		asked.push(message.title);
		control.send(JSON.stringify({ type: "approval", id: message.id, approved: false }));
	}
};
control.send(JSON.stringify({ type: "hello", githubToken: null, minted: { cloudflare: { env: account ? { CLOUDFLARE_ACCOUNT_ID: account } : {} } } }));

const sandbox = "cloudflare-test";
const connection = new WebSocketConnection({ relayUrl, relayToken, sandbox });
const env = new RemoteExecutionEnv({ connection: connection as unknown as Connection, id: `sandbox:${sandbox}`, cwd: "/workspace" });

async function run(label: string, command: string) {
	let output = "";
	const result = await env.exec(command, { onOutput: (text) => (output += text) }, BACKGROUND_CONTEXT);
	const code = result.ok ? result.value.exitCode : result.error.message;
	console.log(`\n## ${label} (exit ${code})\n${output.trim().slice(0, 500)}`);
}

await run("placeholder only", "echo $CLOUDFLARE_API_TOKEN $CLOUDFLARE_ACCOUNT_ID");
await run("read: cf whoami", "cf auth whoami 2>&1 | grep -E 'tokenValid|email' | head -3");
await run("read: zones", "cf zones list 2>&1 | grep -oE '\"name\": \"[a-z0-9-]+\.[a-z.]+\"' | head -3");
await run("read: wrangler whoami", "wrangler whoami 2>&1 | grep -iE 'logged in|account|email' | head -4");
await run("write, declined", "curl -sS -X DELETE -H 'Authorization: Bearer placeholder' https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/pi-mobile-nonexistent-script-0");
console.log(`\n## token requests: ${tokenRequests}\n## approvals asked\n${asked.join("\n")}`);

connection.close();
control.close();
const remove = new URL(`/sandboxes/${sandbox}`, relayUrl.replace(/^ws/, "http"));
remove.searchParams.set("token", relayToken);
await fetch(remove, { method: "DELETE" });
