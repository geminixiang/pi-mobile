// End-to-end check of gcloud in a sandbox through the egress proxy, with this script playing the phone: it answers
// the relay's token requests with GCLOUD_TOKEN and declines every write. The only write it attempts deletes a bucket
// that does not exist, so nothing changes even if it went through.
// Usage: SANDBOX_RELAY=ws://<host>:8787 SANDBOX_TOKEN=... GCLOUD_TOKEN=$(gcloud auth print-access-token <account>) \
//        GCLOUD_PROJECT=<project> node test/gcloud-node.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { WebSocketConnection } from "../src/agent/sandbox/ws-connection.ts";

const relayUrl = process.env.SANDBOX_RELAY ?? "ws://127.0.0.1:8787";
const relayToken = process.env.SANDBOX_TOKEN;
const gcloudToken = process.env.GCLOUD_TOKEN;
const project = process.env.GCLOUD_PROJECT ?? "";
if (!relayToken || !gcloudToken) throw new Error("SANDBOX_TOKEN and GCLOUD_TOKEN must be set");

const asked: string[] = [];
let tokenRequests = 0;
const control = new WebSocket(`${relayUrl}/control?token=${relayToken}`);
await new Promise((resolve, reject) => {
	control.onopen = resolve;
	control.onerror = reject;
});
control.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as { type: string; id: number; title: string; detail: string };
	if (message.type === "gcloud-token") {
		tokenRequests++;
		control.send(JSON.stringify({ type: "gcloud-token", token: gcloudToken, expiresAt: Date.now() + 30 * 60_000 }));
	} else if (message.type === "approve") {
		asked.push(message.title);
		control.send(JSON.stringify({ type: "approval", id: message.id, approved: false }));
	}
};
control.send(JSON.stringify({ type: "hello", githubToken: null, gcloud: { project } }));

const sandbox = "gcloud-test";
const connection = new WebSocketConnection({ relayUrl, relayToken, sandbox });
const env = new RemoteExecutionEnv({ connection: connection as unknown as Connection, id: `sandbox:${sandbox}`, cwd: "/workspace" });

async function run(label: string, command: string) {
	let output = "";
	const result = await env.exec(command, { onOutput: (text) => (output += text) }, BACKGROUND_CONTEXT);
	const code = result.ok ? result.value.exitCode : result.error.message;
	console.log(`\n## ${label} (exit ${code})\n${output.trim().slice(0, 500)}`);
}

await run("no real credential in the sandbox", "cat /etc/pi-egress/gcloud-token; ls ~/.config/gcloud 2>/dev/null || echo 'no gcloud config dir'");
await run("gcloud config", "gcloud config list 2>&1 | grep -E 'project|account'");
await run("read: projects list", "gcloud projects list --format='value(projectId)' --limit 3");
await run("read: project describe", `gcloud projects describe ${project} --format='value(name,lifecycleState)'`);
await run(
	"write, declined",
	"curl -sS -X DELETE -H 'Authorization: Bearer placeholder' https://storage.googleapis.com/storage/v1/b/pi-mobile-nonexistent-bucket-0",
);
await run("POST that only reads (:testIamPermissions) is not asked", `curl -sS -X POST -H 'Authorization: Bearer placeholder' -H 'Content-Type: application/json' -d '{"permissions":["resourcemanager.projects.get"]}' https://cloudresourcemanager.googleapis.com/v1/projects/${project}:testIamPermissions`);
console.log(`\n## token requests: ${tokenRequests}\n## approvals asked\n${asked.join("\n")}`);

connection.close();
control.close();
const remove = new URL(`/sandboxes/${sandbox}`, relayUrl.replace(/^ws/, "http"));
remove.searchParams.set("token", relayToken);
await fetch(remove, { method: "DELETE" });
