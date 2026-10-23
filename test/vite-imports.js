import { register } from "node:module";

register(
	"data:text/javascript," +
		encodeURIComponent(`
		import { readFile } from "node:fs/promises";
		export async function resolve(specifier, context, next) {
			const match = /^(.*)\\?(raw|url)$/.exec(specifier);
			if (!match) return next(specifier, context);
			const resolved = await next(match[1], context);
			return { url: resolved.url + "?" + match[2], shortCircuit: true, format: "module" };
		}
		export async function load(url, context, next) {
			const match = /^(.*)\\?(raw|url)$/.exec(url);
			if (!match) return next(url, context);
			const value = match[2] === "raw" ? await readFile(new URL(match[1]), "utf8") : match[1];
			return { format: "module", source: "export default " + JSON.stringify(value) + ";", shortCircuit: true };
		}
	`),
	import.meta.url,
);
