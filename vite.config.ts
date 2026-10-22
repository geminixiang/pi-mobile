import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url));

/**
 * pi-env's daemons for the machines the app deploys to over SSH (src/agent/sandbox/machine.ts), served as
 * /pi-env/<os>-<arch>.bin from the installed @earendil-works/pi-env, so they are never committed and match its version.
 * `.bin` because Capacitor's server answers paths without an extension with index.html. Their SHA-256 are built into
 * the app (__PI_ENV_DAEMONS__), and the app uploads only bytes that match.
 */
const DAEMONS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const daemonFile = (name: string) => new URL(`./node_modules/@earendil-works/pi-env/bin/pi-env-${name}/pi-env`, import.meta.url);
function piEnvDaemons(): Plugin {
	return {
		name: "pi-env-daemons",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const name = request.url?.match(/^\/pi-env\/([a-z0-9-]+)\.bin$/)?.[1];
				if (!name || !DAEMONS.includes(name)) return next();
				response.setHeader("Content-Type", "application/octet-stream");
				response.end(readFileSync(daemonFile(name)));
			});
		},
		generateBundle() {
			for (const name of DAEMONS) this.emitFile({ type: "asset", fileName: `pi-env/${name}.bin`, source: readFileSync(daemonFile(name)) });
		},
	};
}

/**
 * pdf.js's data (attachments-pdf.ts): CMaps, without which text in CJK fonts comes out empty, the standard fonts for
 * rendering pages, and its image decoders' wasm. Served as /pdfjs/<dir>/<file> from the installed pdfjs-dist, so they
 * match its version and are never committed.
 */
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm"];
const pdfjsDir = (dir: string) => new URL(`./node_modules/pdfjs-dist/${dir}/`, import.meta.url);
function pdfjsAssets(): Plugin {
	return {
		name: "pdfjs-assets",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const match = request.url?.match(/^\/pdfjs\/([a-z_]+)\/([\w.-]+)$/);
				if (!match || !PDFJS_DIRS.includes(match[1])) return next();
				response.end(readFileSync(new URL(match[2], pdfjsDir(match[1]))));
			});
		},
		generateBundle() {
			for (const dir of PDFJS_DIRS) {
				for (const file of readdirSync(pdfjsDir(dir))) {
					if (file.includes(".")) this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${file}`, source: readFileSync(new URL(file, pdfjsDir(dir))) });
				}
			}
		},
	};
}

export default defineConfig({
	plugins: [react(), piEnvDaemons(), pdfjsAssets()],
	// Shown in Settings: the commit the build came from, and when it was built.
	define: {
		__PI_ENV_DAEMONS__: JSON.stringify(
			Object.fromEntries(DAEMONS.map((name) => [name, createHash("sha256").update(readFileSync(daemonFile(name))).digest("hex")])),
		),
		__BUILD__: JSON.stringify(
			`${execSync("git rev-parse --short HEAD").toString().trim()} · ${new Date().toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })}`,
		),
	},
	// Code mode's QuickJS VM runs in a module worker (src/agent/codemode-worker.ts).
	worker: { format: "es" },
	resolve: {
		// @earendil-works/pi-env imports Node built-ins; the app uses its RemoteExecutionEnv over a WebSocket.
		alias: {
			"@earendil-works/pi-env": shim("pi-env.ts"),
			"@earendil-works/pi-durable/env/node": shim("durable-env-node.ts"),
			"node:crypto": shim("node-crypto.ts"),
			"node:path": shim("node-path.ts"),
			"node:url": shim("node-url.ts"),
			"node:string_decoder": "string_decoder",
			"node:child_process": shim("node-child-process.ts"),
			// just-bash (src/agent/files/shell-worker.ts) imports it for gzip only.
			"node:zlib": shim("node-zlib.ts"),
		},
	},
});
