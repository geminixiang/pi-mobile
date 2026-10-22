// Sandbox relay: lets the phone reach a pi-env daemon inside a per-conversation container.
//
// The phone opens a WebSocket to /env/<sandbox>?token=<relay token>&daemonToken=<hex>. The relay makes sure the
// container exists and runs, starts `docker exec -i <container> pi-env serve --token <hex>`, and copies bytes both
// ways. The pi-env wire protocol is unchanged: the relay never parses frames.
//
// GitHub access from sandboxes goes through the egress proxy (sandbox/egress): a mitmproxy container on the
// pi-egress network that every sandbox uses as its HTTP(S) proxy. The token never enters a sandbox. The phone keeps a
// control WebSocket open (/control) and sends the token, which the relay holds in memory only; the proxy asks the
// relay per request (/egress/authorize). Writes are forwarded to the phone for approval first.
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const run = promisify(execFile);

const HOST = process.env.RELAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT ?? 8787);
const TOKEN = process.env.RELAY_TOKEN;
const IMAGE = process.env.SANDBOX_IMAGE ?? "pi-sandbox";
// Stopped containers only hold disk, so the limit is on running ones.
const MAX_RUNNING = Number(process.env.MAX_RUNNING ?? 6);
const IDLE_STOP_MS = Number(process.env.IDLE_STOP_MS ?? 30 * 60_000);
const CPUS = process.env.SANDBOX_CPUS ?? "2";
const MEMORY = process.env.SANDBOX_MEMORY ?? "2g";
const PIDS = process.env.SANDBOX_PIDS ?? "512";

const EGRESS_SECRET = process.env.EGRESS_SECRET;
const EGRESS = "pi-egress";
const EGRESS_IMAGE = "pi-egress";
const EGRESS_PROXY = `http://${EGRESS}:8080`;
/** How long the token stays usable after the phone disconnects, so a running clone or fetch can finish. */
const TOKEN_GRACE_MS = Number(process.env.TOKEN_GRACE_MS ?? 10 * 60_000);
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const CA_PATH = "/usr/local/share/ca-certificates/pi-egress.crt";

if (!TOKEN) throw new Error("RELAY_TOKEN is not set");
if (!EGRESS_SECRET) throw new Error("EGRESS_SECRET is not set");

/** Environment for the daemon and everything it runs: proxy, CA bundle for runtimes with their own, gh placeholder. */
const SANDBOX_ENV = {
	HTTP_PROXY: EGRESS_PROXY,
	HTTPS_PROXY: EGRESS_PROXY,
	http_proxy: EGRESS_PROXY,
	https_proxy: EGRESS_PROXY,
	NO_PROXY: "localhost,127.0.0.1,::1",
	no_proxy: "localhost,127.0.0.1,::1",
	// gh refuses to run without a token; the proxy replaces this placeholder with the real one.
	GH_TOKEN: "injected-by-pi-egress",
	GIT_TERMINAL_PROMPT: "0",
	// gcloud authenticates with this placeholder token; the proxy swaps in a real one from the phone.
	CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "/etc/pi-egress/gcloud-token",
	CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE: "/etc/ssl/certs/ca-certificates.crt",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
	CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
	CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true",
	// cf and wrangler authenticate with this placeholder; the proxy swaps in a real token on api.cloudflare.com.
	CLOUDFLARE_API_TOKEN: "injected-by-pi-egress",
	WRANGLER_SEND_METRICS: "false",
	// az signs in as a managed identity served by the relay (placeholders); the proxy swaps in real tokens.
	IDENTITY_ENDPOINT: `http://${HOST}:${PORT}/azure/identity`,
	IDENTITY_HEADER: "pi-mobile",
	AZURE_CORE_COLLECT_TELEMETRY: "no",
	AZURE_CORE_ONLY_SHOW_ERRORS: "true",
	NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
	// Node's built-in fetch ignores HTTP(S)_PROXY unless asked (Node 24); cf and other Node tools use it.
	NODE_USE_ENV_PROXY: "1",
	REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
	SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
};

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

/** At the running limit, stop the least recently used sandbox that has no open session. */
async function makeRoom() {
	const running = (await sandboxes()).filter((sandbox) => sandbox.state === "running");
	if (running.length < MAX_RUNNING) return;
	const idle = running
		.filter((sandbox) => sandbox.connections === 0)
		.sort((a, b) => (lastUsed.get(a.id) ?? 0) - (lastUsed.get(b.id) ?? 0))[0];
	if (!idle) throw new Error(`All ${MAX_RUNNING} running sandboxes are in use`);
	await docker("stop", "-t", "2", containerName(idle.id));
	log("stopped to make room", containerName(idle.id));
}

async function ensureContainerNow(id) {
	const name = containerName(id);
	const state = await docker("inspect", "-f", "{{.State.Running}}", name).catch(() => undefined);
	if (state === "true") return;
	await makeRoom();
	if (state === "false") {
		await docker("start", name);
		log("started", name);
		return;
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
		"--network", EGRESS,
		"-v", `${name}:/workspace`,
		IMAGE,
	);
	log("created", name);
}

/** One-time memo: concurrent callers share the pending promise; a failure lets the next caller retry. */
function once(fn) {
	let pending;
	return () => {
		pending ??= fn().catch((error) => {
			pending = undefined;
			throw error;
		});
		return pending;
	};
}

// ---------- Egress proxy ----------

let caCert;

/** Network, proxy container (recreated when the image changes), and its CA certificate. */
const ensureEgress = once(async () => {
	if (!(await docker("network", "ls", "-q", "--filter", `name=^${EGRESS}$`))) await docker("network", "create", EGRESS);
	const image = await docker("image", "inspect", "-f", "{{.Id}}", EGRESS_IMAGE);
	const current = await docker("inspect", "-f", "{{.Image}} {{.State.Running}}", EGRESS).catch(() => "");
	const [imageId, running] = current.split(" ");
	if (imageId !== image || running !== "true") {
		if (current) await docker("rm", "-f", EGRESS);
		await docker(
			"run", "-d",
			"--name", EGRESS,
			"--network", EGRESS,
			"--restart", "unless-stopped",
			"-v", "pi-egress-ca:/home/mitmproxy/.mitmproxy",
			"-e", `RELAY_URL=http://${HOST}:${PORT}`,
			"-e", `EGRESS_SECRET=${EGRESS_SECRET}`,
			EGRESS_IMAGE,
		);
		log("started", EGRESS);
	}
	// mitmproxy writes its CA on first start.
	for (let attempt = 0; attempt < 40 && !caCert; attempt++) {
		caCert = await docker("exec", EGRESS, "cat", "/home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem").catch(() => undefined);
		if (!caCert) await new Promise((resolve) => setTimeout(resolve, 250));
	}
	if (!caCert) throw new Error("egress proxy did not create its CA certificate");
});

/** Container IDs already joined to the egress network and trusting its CA, since the relay started. */
const prepared = new Set();

async function prepareSandbox(name) {
	await ensureEgress();
	const id = await docker("inspect", "-f", "{{.Id}}", name);
	if (prepared.has(id)) return;
	// Containers created before the egress proxy existed are on the default network; join them too.
	await docker("network", "connect", EGRESS, name).catch((error) => {
		if (!/already exists/.test(String(error?.stderr ?? error))) throw error;
	});
	await new Promise((resolve, reject) => {
		const child = spawn("docker", [
			"exec", "-i", name, "sh", "-c",
			`cat > /tmp/pi-egress.crt && if ! cmp -s /tmp/pi-egress.crt ${CA_PATH}; then mv /tmp/pi-egress.crt ${CA_PATH} && update-ca-certificates >/dev/null 2>&1; else rm /tmp/pi-egress.crt; fi`,
		]);
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`installing the egress CA failed (${code})`))));
		child.stdin.end(caCert);
	});
	prepared.add(id);
}

/** Sandbox name for a client IP on the egress network. */
async function sandboxForIp(ip) {
	const out = await docker("network", "inspect", EGRESS, "-f", "{{range .Containers}}{{.Name}} {{.IPv4Address}}\n{{end}}");
	for (const line of out.split("\n")) {
		const [name, address] = line.trim().split(" ");
		if (address?.split("/")[0] === ip && name.startsWith("sbx-")) return name.slice(4);
	}
	return undefined;
}

// ---------- Phone control channel ----------

/** Open control sockets, newest last. */
const phones = [];
let githubToken;
let tokenExpiry;
/**
 * Services whose long-lived credential stays on the phone (Google Cloud, Cloudflare): the relay asks the phone for a
 * short-lived access token when the proxy needs one and caches it until it nears expiry.
 * name -> { env: sandbox variables from the phone, token, expiresAt, waiters }
 */
const minted = new Map();
const MINTED_LABELS = { gcloud: "Google Cloud", cloudflare: "Cloudflare", azure: "Azure" };
const approvals = new Map();
let nextApproval = 1;

function phone() {
	return phones.at(-1);
}

function sendApproval(socket, approval) {
	socket.send(JSON.stringify({ type: "approve", id: approval.id, sandbox: approval.sandbox, title: approval.title, detail: approval.detail }));
}

function attachPhone(ws) {
	phones.push(ws);
	clearTimeout(tokenExpiry);
	log("phone connected", phones.length);
	ws.on("message", (data, isBinary) => {
		if (isBinary) return;
		let message;
		try {
			message = JSON.parse(String(data));
		} catch {
			return;
		}
		if (message.type === "hello") {
			githubToken = typeof message.githubToken === "string" && message.githubToken ? message.githubToken : undefined;
			minted.clear();
			for (const [service, settings] of Object.entries(message.minted ?? {})) {
				if (!MINTED_LABELS[service] || !settings || typeof settings !== "object") continue;
				const env = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([key, value]) => /^[A-Z_]+$/.test(key) && typeof value === "string" && value));
				minted.set(service, { env, tokens: new Map(), waiters: new Map() });
			}
			// Questions asked while the phone was away.
			for (const approval of approvals.values()) sendApproval(ws, approval);
		} else if (message.type === "token") {
			const entry = minted.get(message.service);
			if (!entry) return;
			const scope = String(message.scope ?? "");
			if (typeof message.token === "string") entry.tokens.set(scope, { token: message.token, expiresAt: Number(message.expiresAt) });
			for (const resolve of entry.waiters.get(scope)?.splice(0) ?? []) resolve(message.error ? { error: String(message.error) } : undefined);
		} else if (message.type === "approval") {
			approvals.get(message.id)?.resolve(message.approved === true);
		}
	});
	ws.on("close", () => {
		phones.splice(phones.indexOf(ws), 1);
		log("phone disconnected", phones.length);
		if (phones.length === 0) {
			tokenExpiry = setTimeout(() => {
				githubToken = undefined;
				log("github token dropped");
			}, TOKEN_GRACE_MS);
		}
	});
}

function askPhone(sandbox, title, detail) {
	return new Promise((resolve) => {
		const id = nextApproval++;
		const approval = {
			id,
			sandbox,
			title,
			detail,
			resolve: (approved) => {
				clearTimeout(timer);
				approvals.delete(id);
				resolve(approved);
			},
		};
		const timer = setTimeout(() => approval.resolve(false), APPROVAL_TIMEOUT_MS);
		approvals.set(id, approval);
		const socket = phone();
		if (socket) sendApproval(socket, approval);
	});
}

async function readJson(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Called by the egress addon for each GitHub request: the token for reads, and for approved writes. */
/**
 * An access token for `service` valid for at least a minute, from the cache or freshly minted by the phone. `scope`
 * names the resource for services with one token per resource (Azure); others use "".
 */
async function mintedToken(service, scope = "") {
	const label = MINTED_LABELS[service] ?? service;
	const entry = minted.get(service);
	if (!entry) return { reason: `手機沒有設定 ${label} 憑證` };
	const cached = entry.tokens.get(scope);
	if (cached && cached.expiresAt - Date.now() > 60_000) return { token: cached.token };
	const socket = phone();
	if (!socket) return { reason: `手機沒有連上，無法取得 ${label} token` };
	const answer = await new Promise((resolve) => {
		if (!entry.waiters.has(scope)) entry.waiters.set(scope, []);
		entry.waiters.get(scope).push(resolve);
		socket.send(JSON.stringify({ type: "token", service, scope }));
		setTimeout(() => resolve({ error: "手機沒有回應" }), 20_000);
	});
	if (answer?.error) return { reason: `取得 ${label} token 失敗：${answer.error}` };
	const token = entry.tokens.get(scope);
	return token ? { token: token.token } : { reason: `手機沒有設定 ${label} 憑證` };
}

/** Called by the egress addon for each intercepted request: a token for reads, and for approved writes. */
async function authorizeEgress(body) {
	if (MINTED_LABELS[body.service]) {
		const scope = String(body.scope ?? "");
		const token = await mintedToken(body.service, scope);
		if (!token.token || !body.write) return token;
		if (!phone()) return { reason: "手機沒有連上，無法確認這個寫入" };
		const sandbox = (await sandboxForIp(String(body.client ?? ""))) ?? "unknown";
		log("approval asked", sandbox, body.title);
		const approved = await askPhone(sandbox, String(body.title ?? ""), String(body.detail ?? ""));
		log("approval", approved ? "granted" : "denied", sandbox, body.title);
		return approved ? await mintedToken(body.service, scope) : { reason: "使用者拒絕了這個寫入" };
	}
	if (!githubToken) return { reason: "手機沒有連上，或沒有設定 GitHub token" };
	if (!body.write) return { token: githubToken };
	if (!phone()) return { reason: "手機沒有連上，無法確認這個寫入" };
	const sandbox = (await sandboxForIp(String(body.client ?? ""))) ?? "unknown";
	log("approval asked", sandbox, body.title);
	const approved = await askPhone(sandbox, String(body.title ?? ""), String(body.detail ?? ""));
	log("approval", approved ? "granted" : "denied", sandbox, body.title);
	return approved && githubToken ? { token: githubToken } : { reason: "使用者拒絕了這個寫入" };
}

// ---------- Azure managed identity ----------

/**
 * az in the sandbox signs in with `az login --identity`; IDENTITY_ENDPOINT points here (App Service's managed
 * identity protocol). The tokens are placeholders: well-formed JWTs with the tenant from the phone and no signature
 * Azure would accept. The proxy replaces them with real tokens on Azure's hosts, so nothing here grants access.
 */
function azurePlaceholder(resource) {
	const env = minted.get("azure")?.env ?? {};
	const tenant = env.AZURE_TENANT_ID ?? "00000000-0000-0000-0000-000000000000";
	const now = Math.floor(Date.now() / 1000);
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const claims = {
		aud: resource,
		iss: `https://sts.windows.net/${tenant}/`,
		tid: tenant,
		oid: "00000000-0000-0000-0000-00000000p1m0",
		appid: "pi-mobile-egress",
		iat: now,
		nbf: now,
		exp: now + 3600,
	};
	const token = `${encode({ alg: "RS256", typ: "JWT", kid: "pi-egress" })}.${encode(claims)}.${Buffer.from("injected-by-pi-egress").toString("base64url")}`;
	return { access_token: token, expires_on: String(now + 3600), resource, token_type: "Bearer" };
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
		if (url.pathname === "/azure/identity") {
			if (!minted.has("azure")) return reply(400, { error: "invalid_request", error_description: "pi mobile: 手機沒有設定 Azure 憑證" });
			return reply(200, azurePlaceholder(url.searchParams.get("resource") ?? "https://management.core.windows.net/"));
		}
		if (request.method === "POST" && url.pathname === "/egress/authorize") {
			if (request.headers["x-egress-secret"] !== EGRESS_SECRET) return reply(401, { error: "unauthorized" });
			return reply(200, await authorizeEgress(await readJson(request)));
		}
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
	if (url.pathname === "/control") {
		if (!authorized(url)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, attachPhone);
		return;
	}
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
		await prepareSandbox(name);
	} catch (error) {
		ws.close(1011, String(error instanceof Error ? error.message : error).slice(0, 120));
		return;
	}
	if (ws.readyState !== ws.OPEN) return;
	sessions.set(id, (sessions.get(id) ?? 0) + 1);
	lastUsed.set(id, Date.now());
	log("attach", name);

	// Per-service settings from the phone, such as the default Google Cloud project or Cloudflare account.
	const serviceEnv = Object.assign({}, ...[...minted.values()].map((entry) => entry.env));
	const env = Object.entries({ ...SANDBOX_ENV, ...serviceEnv }).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
	const child = spawn("docker", ["exec", "-i", "-w", "/workspace", ...env, name, "pi-env", "serve", "--token", daemonToken], {
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

server.listen(PORT, HOST, () => {
	log(`relay on ${HOST}:${PORT}, image ${IMAGE}, max ${MAX_RUNNING} running`);
	ensureEgress().catch((error) => log("egress proxy failed:", error instanceof Error ? error.message : error));
});
