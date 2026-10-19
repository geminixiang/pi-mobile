// Sandbox relay: lets the phone reach a pi-env daemon inside a per-conversation container.
//
// The phone opens a WebSocket to /env/<sandbox>?token=<relay token>&daemonToken=<hex>. The relay makes sure the
// container exists and runs, starts `docker exec -i <container> pi-env serve --token <hex>`, and copies bytes both
// ways. The pi-env wire protocol is unchanged: the relay never parses frames.
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const run = promisify(execFile);

const HOST = process.env.RELAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT ?? 8787);
const TOKEN = process.env.RELAY_TOKEN;
const IMAGE = process.env.SANDBOX_IMAGE ?? "pi-sandbox";
const MAX_SANDBOXES = Number(process.env.MAX_SANDBOXES ?? 6);
const IDLE_STOP_MS = Number(process.env.IDLE_STOP_MS ?? 30 * 60_000);
const CPUS = process.env.SANDBOX_CPUS ?? "2";
const MEMORY = process.env.SANDBOX_MEMORY ?? "2g";
const PIDS = process.env.SANDBOX_PIDS ?? "512";

if (!TOKEN) throw new Error("RELAY_TOKEN is not set");

const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const containerName = (id) => `sbx-${id}`;

/** Open daemon sessions per sandbox, and when each sandbox was last used. */
const sessions = new Map();
const lastUsed = new Map();

function log(...parts) {
	console.log(new Date().toISOString(), ...parts);
}

async function docker(...args) {
	const { stdout } = await run("docker", args, { maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

async function sandboxes() {
	const out = await docker("ps", "-a", "--filter", "label=pi-sandbox=1", "--format", "{{.Names}}\t{{.State}}\t{{.CreatedAt}}");
	return out
		? out.split("\n").map((line) => {
				const [name, state, created] = line.split("\t");
				return { id: name.replace(/^sbx-/, ""), state, created, connections: sessions.get(name.replace(/^sbx-/, "")) ?? 0 };
			})
		: [];
}

/** Create or start the sandbox's container. Serialized per sandbox so two connections do not race. */
const ensuring = new Map();
function ensureContainer(id) {
	const pending = ensuring.get(id) ?? ensureContainerNow(id).finally(() => ensuring.delete(id));
	ensuring.set(id, pending);
	return pending;
}

async function ensureContainerNow(id) {
	const name = containerName(id);
	const state = await docker("inspect", "-f", "{{.State.Running}}", name).catch(() => undefined);
	if (state === "true") return;
	if (state === "false") {
		await docker("start", name);
		log("started", name);
		return;
	}
	if ((await sandboxes()).length >= MAX_SANDBOXES) {
		throw new Error(`Sandbox limit reached (${MAX_SANDBOXES}); remove one first`);
	}
	await docker(
		"run", "-d",
		"--name", name,
		"--label", "pi-sandbox=1",
		"--hostname", name,
		"--cpus", CPUS,
		"--memory", MEMORY,
		"--pids-limit", PIDS,
		"--restart", "no",
		"-v", `${name}:/workspace`,
		IMAGE,
	);
	log("created", name);
}

function authorized(url) {
	return url.searchParams.get("token") === TOKEN;
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://relay");
	// The app's WebView origin (http://localhost) differs from the relay's, so DELETE needs a CORS preflight.
	const cors = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "*",
	};
	const reply = (status, body) => {
		response.writeHead(status, { "Content-Type": "application/json", ...cors });
		response.end(JSON.stringify(body));
	};
	if (request.method === "OPTIONS") {
		response.writeHead(204, cors);
		response.end();
		return;
	}
	try {
		if (url.pathname === "/health") return reply(200, { ok: true });
		if (!authorized(url)) return reply(401, { error: "unauthorized" });
		if (request.method === "GET" && url.pathname === "/sandboxes") return reply(200, await sandboxes());
		const match = /^\/sandboxes\/([^/]+)$/.exec(url.pathname);
		if (request.method === "DELETE" && match && SANDBOX_ID.test(match[1])) {
			const name = containerName(match[1]);
			await docker("rm", "-f", name).catch(() => "");
			await docker("volume", "rm", name).catch(() => "");
			log("removed", name);
			return reply(200, { removed: match[1] });
		}
		reply(404, { error: "not found" });
	} catch (error) {
		reply(500, { error: error instanceof Error ? error.message : String(error) });
	}
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

server.on("upgrade", (request, socket, head) => {
	const url = new URL(request.url ?? "/", "http://relay");
	const match = /^\/env\/([^/]+)$/.exec(url.pathname);
	const daemonToken = url.searchParams.get("daemonToken") ?? "";
	if (!authorized(url) || !match || !SANDBOX_ID.test(match[1]) || !/^[0-9a-f]{16,64}$/.test(daemonToken)) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(request, socket, head, (ws) => void attach(ws, match[1], daemonToken));
});

async function attach(ws, id, daemonToken) {
	const name = containerName(id);
	// The client may send its first frames (hello) before the container is ready; hold them until the daemon runs.
	const early = [];
	const hold = (data, isBinary) => {
		if (isBinary) early.push(data);
	};
	ws.on("message", hold);
	try {
		await ensureContainer(id);
	} catch (error) {
		ws.close(1011, String(error instanceof Error ? error.message : error).slice(0, 120));
		return;
	}
	if (ws.readyState !== ws.OPEN) return;
	sessions.set(id, (sessions.get(id) ?? 0) + 1);
	lastUsed.set(id, Date.now());
	log("attach", name);

	const child = spawn("docker", ["exec", "-i", "-w", "/workspace", name, "pi-env", "serve", "--token", daemonToken], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => {
		lastUsed.set(id, Date.now());
		if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
	});
	child.stderr.on("data", (chunk) => log(name, "stderr:", chunk.toString("utf8").trim()));
	child.stdin.on("error", () => {});
	ws.off("message", hold);
	for (const data of early) child.stdin.write(data);
	ws.on("message", (data, isBinary) => {
		lastUsed.set(id, Date.now());
		if (isBinary) child.stdin.write(data);
	});

	let closed = false;
	const close = (why) => {
		if (closed) return;
		closed = true;
		sessions.set(id, Math.max(0, (sessions.get(id) ?? 1) - 1));
		lastUsed.set(id, Date.now());
		log("detach", name, why);
		child.stdin.end();
		child.kill();
		if (ws.readyState === ws.OPEN) ws.close(1000, why);
	};
	ws.on("close", () => close("client closed"));
	ws.on("error", () => close("socket error"));
	child.on("exit", (code) => close(`daemon exited ${code}`));
}

// Stop containers nobody used for a while. Their files stay in the volume; the next connection starts them again.
setInterval(async () => {
	try {
		for (const sandbox of await sandboxes()) {
			if (sandbox.state !== "running" || sandbox.connections > 0) continue;
			const idle = Date.now() - (lastUsed.get(sandbox.id) ?? 0);
			if (idle < IDLE_STOP_MS) continue;
			await docker("stop", "-t", "5", containerName(sandbox.id));
			log("stopped idle", containerName(sandbox.id));
		}
	} catch (error) {
		log("idle sweep failed:", error instanceof Error ? error.message : error);
	}
}, 60_000).unref();

server.listen(PORT, HOST, () => log(`relay on ${HOST}:${PORT}, image ${IMAGE}, max ${MAX_SANDBOXES}`));
