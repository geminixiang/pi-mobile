import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

const ENTRY = fileURLToPath(new URL("../src/agent/browser-page.ts", import.meta.url));

async function bundle(): Promise<string> {
	const result = await build({
		configFile: false,
		logLevel: "warn",
		build: {
			write: false,
			minify: true,
			lib: { entry: ENTRY, formats: ["iife"], name: "piPageScript", fileName: () => "page-controller.js" },
			rollupOptions: { output: { inlineDynamicImports: true } },
		},
	});
	const outputs = Array.isArray(result) ? result : [result];
	for (const output of outputs) {
		if (!("output" in output)) continue;
		for (const chunk of output.output) if (chunk.type === "chunk") return chunk.code;
	}
	throw new Error("page-controller.js was not built");
}

export function pageControllerScript(): Plugin {
	return {
		name: "page-controller-script",
		async generateBundle() {
			this.emitFile({ type: "asset", fileName: "page-controller.js", source: await bundle() });
		},
	};
}
