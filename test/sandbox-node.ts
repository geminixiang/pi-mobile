// Node check of the sandbox path: WebSocketConnection -> relay -> container pi-env, driven by pi-env's
// RemoteExecutionEnv and Durable's env conformance-style operations.
// Usage: SANDBOX_RELAY=ws://100.121.187.60:8787 SANDBOX_TOKEN=... node test/sandbox-node.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { WebSocketConnection } from "../src/agent/sandbox/ws-connection.ts";

const relayUrl = process.env.SANDBOX_RELAY ?? "ws://127.0.0.1:8787";
const relayToken = process.env.SANDBOX_TOKEN;
if (!relayToken) throw new Error("SANDBOX_TOKEN is not set");

const context = BACKGROUND_CONTEXT;
const connection = new WebSocketConnection({ relayUrl, relayToken, sandbox: "node-test", onLog: (text) => console.error("[log]", text) });
const env = new RemoteExecutionEnv({ connection: connection as unknown as Connection, id: "sandbox:node-test", cwd: "/workspace" });

const started = performance.now();
console.log("info", await connection.info(), `${Math.round(performance.now() - started)} ms`);
console.log("write", await env.writeFile("hello.txt", "你好 sandbox\n", context));
console.log("read", await env.readTextFile("hello.txt", context));
let output = "";
const exec = await env.exec("uname -m && node -v && python3 -V && git --version && ls -la", { onOutput: (text) => (output += text) }, context);
console.log("exec", exec, "\n" + output);
console.log("listDir", (await env.listDir(".", context)).ok);
connection.close();
