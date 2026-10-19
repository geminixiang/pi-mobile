import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url));

export default defineConfig({
	plugins: [react()],
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
		},
	},
});
