import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Page } from "./page.ts";
import { PhoneScreen } from "../../src/phone-screen/plugin.ts";
import { check, parseJson } from "../../src/parse.ts";

const [mode, target, input = "{}"] = process.argv.slice(2);
if (mode === "identity") {
	const options = parseJson(input, "identity options");
	const before = parseJson(readFileSync(target, "utf8"), "before");
	const after = parseJson(readFileSync(options.after, "utf8"), "after");
	for (const result of [before, after]) assert(!result.value.delta && result.value.more === 0, "identity comparison needs complete, full observations");
	const lines = before.value.elements.split("\n");
	const at = lines.findIndex((line) => line.includes(`"${options.label}"`));
	assert(at > 0, "named row must have an unlabeled wrapper before it");
	const wrapper = lines[at - 1];
	assert(wrapper.includes("] button at "), "preceding line is not an unlabeled wrapper");
	const id = wrapper.split(" ")[0];
	const current = after.value.elements.split("\n");
	const found = current.findIndex((line) => line.startsWith(`${id} `));
	assert(found < 0 || current[found + 1]?.includes(`"${options.label}"`), `${id} was reused after its row changed: ${wrapper}`);
	console.log(`${found < 0 ? "retired" : "retained"} ${id}: ${options.label}`);
	process.exit(0);
}
assert(mode === "start" || mode === "result", "usage: node --import ./test/vite-imports.js test/device/ios-screen.js start <status|read|act|route> '<args>' | result <output.json> '<expected fields>' | identity <before.json> '{\"after\":\"after.json\",\"label\":\"row label\"}'");
const page = await Page.connect(process.env.CDP_PORT ?? "9240");
try {
	if (mode === "start") {
		assert(["status", "read", "act", "route"].includes(target), "choose status, read, act or route");
		const supplied = parseJson(input, "arguments");
		if (target === "route") for (const key of ["app", "entry", "ready", "target", "expected"]) assert.equal(typeof supplied[key], "string", `route needs ${key}`);
		const method = target === "route" ? "act" : target;
		const args = target === "route" ? {
			steps: [
				{ action: "open", app: supplied.app },
				{ action: "tap", text: supplied.entry },
				{ action: "wait_for", text: supplied.ready, gone: false, ms: 3000 },
				{ action: "scroll_to", text: supplied.target, direction: supplied.direction ?? "down" },
				{ action: "tap", text: supplied.target },
				{ action: "expect", app: supplied.app, text: supplied.expected },
				{ action: "key", key: "back" },
			], screenshot: true,
		} : supplied;
		assert(check(PhoneScreen.contract.methods[method].args, args, method).ok, "arguments do not match PhoneScreen's contract");
		const expression = `(() => {
			const started = Date.now();
			window.__iosScreenResult = { method: ${JSON.stringify(method)}, started, pending: true };
			window.__iosScreenPromise = window.Capacitor.Plugins.PhoneScreen[${JSON.stringify(method)}](${JSON.stringify(args)}).then(
				value => window.__iosScreenResult = { method: ${JSON.stringify(method)}, started, ms: Date.now() - started, value },
				error => window.__iosScreenResult = { method: ${JSON.stringify(method)}, started, ms: Date.now() - started, error: String(error) }
			);
			return "started";
		})()`;
		const reply = await page.command("Runtime.evaluate", { expression, returnByValue: true });
		assert.equal(reply.result?.value, "started", JSON.stringify(reply));
		console.log("started; use result to await and collect the native outcome");
	} else {
		assert(target?.endsWith(".json"), "give an output.json path");
		const result = await page.eval("return window.__iosScreenPromise ?? window.__iosScreenResult;");
		assert(result && typeof result === "object", "no result; start a call first");
		assert(!result.pending, "still pending; collect again when it completes");
		writeFileSync(target, JSON.stringify(result, null, 2) + "\n");
		assert(!result.error, result.error);
		const schema = PhoneScreen.contract.methods[result.method]?.result;
		assert(schema, "unknown PhoneScreen result");
		const checked = check(schema, result.value, result.method);
		assert(checked.ok, checked.problem);
		const expected = parseJson(input, "expected fields");
		if (expected.error === undefined) assert(!result.value.error, result.value.error);
		for (const [key, value] of Object.entries(expected)) assert.deepEqual(result.value[key], value, key);
		if (result.value.jpeg) writeFileSync(target.slice(0, -5) + ".jpg", Buffer.from(result.value.jpeg, "base64"));
		console.log(JSON.stringify({ method: result.method, started: result.started, ms: result.ms, ...result.value, jpeg: result.value.jpeg ? "saved beside JSON" : undefined }, null, 2));
	}
} finally {
	page.close();
}
