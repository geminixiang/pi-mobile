import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const childProcessShim = new URL("../src/shims/node-child-process.ts", import.meta.url).href;
const viteQuery = /^(.*)\?(raw|url)$/;

registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "node:child_process" && context.parentURL?.includes("/@earendil-works/pi-env/")) return { url: childProcessShim, shortCircuit: true };
		const match = viteQuery.exec(specifier);
		if (!match) return next(specifier, context);
		return { url: next(match[1], context).url + "?" + match[2], shortCircuit: true, format: "module" };
	},
	load(url, context, next) {
		const match = viteQuery.exec(url);
		if (!match) return next(url, context);
		const value = match[2] === "raw" ? readFileSync(new URL(match[1]), "utf8") : match[1];
		return { format: "module", source: "export default " + JSON.stringify(value) + ";", shortCircuit: true };
	},
});
