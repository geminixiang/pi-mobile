type Token = { kind: "word" | "string" | "symbol"; text: string };
const WORD = /[\p{L}\p{N}_]/u;

type Block = { body: Token[]; end: number };

function tokens(source: string): Token[] {
	const result: Token[] = [];
	const cursor = { at: 0 };
	while (cursor.at < source.length) {
		const char = source[cursor.at] ?? "";
		if (char.trim() === "") {
			cursor.at++;
			continue;
		}
		if (source.startsWith("//", cursor.at)) {
			const end = source.indexOf("\n", cursor.at);
			cursor.at = end < 0 ? source.length : end;
			continue;
		}
		if (source.startsWith("/*", cursor.at)) {
			cursor.at += 2;
			const nesting = { depth: 1 };
			while (cursor.at < source.length && nesting.depth > 0) {
				if (source.startsWith("/*", cursor.at)) { nesting.depth++; cursor.at += 2; continue; }
				if (source.startsWith("*/", cursor.at)) { nesting.depth--; cursor.at += 2; continue; }
				cursor.at++;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = source.startsWith(char.repeat(3), cursor.at) ? char.repeat(3) : char;
			cursor.at += quote.length;
			const start = cursor.at;
			while (cursor.at < source.length && !source.startsWith(quote, cursor.at)) cursor.at += source[cursor.at] === "\\" ? 2 : 1;
			result.push({ kind: "string", text: source.slice(start, cursor.at) });
			cursor.at += quote.length;
			continue;
		}
		if (WORD.test(char)) {
			const start = cursor.at++;
			while (cursor.at < source.length && WORD.test(source[cursor.at] ?? "")) cursor.at++;
			result.push({ kind: "word", text: source.slice(start, cursor.at) });
			continue;
		}
		const symbol = source.startsWith("->", cursor.at) ? "->" : char;
		result.push({ kind: "symbol", text: symbol });
		cursor.at += symbol.length;
	}
	return result;
}

function block(source: Token[], start: number, open: string, close: string): Block | undefined {
	if (source[start]?.text !== open) return undefined;
	const nesting = { depth: 1 };
	for (const [offset, token] of source.slice(start + 1).entries()) {
		if (token.kind !== "symbol") continue;
		if (token.text === open) nesting.depth++;
		if (token.text === close) nesting.depth--;
		if (nesting.depth === 0) return { body: source.slice(start + 1, start + 1 + offset), end: start + 1 + offset };
	}
	return undefined;
}

function labels(body: Token[], language: "kotlin" | "swift"): string[] {
	const found: string[] = [];
	const nesting = { depth: 0 };
	for (const [index, token] of body.entries()) {
		if (token.kind === "symbol" && ["{", "(", "["].includes(token.text)) nesting.depth++;
		if (token.kind === "symbol" && ["}", ")", "]"].includes(token.text)) nesting.depth--;
		if (nesting.depth !== 0) continue;
		if (language === "swift" && token.kind === "word" && token.text === "case") {
			for (const label of body.slice(index + 1)) {
				if (label.kind === "symbol" && label.text === ":") break;
				if (label.kind === "string") found.push(label.text);
			}
		}
		if (language === "kotlin" && token.kind === "symbol" && token.text === "->") {
			for (const label of body.slice(0, index).reverse()) {
				if (label.kind === "string") { found.push(label.text); continue; }
				if (label.kind === "symbol" && label.text === ",") continue;
				break;
			}
		}
	}
	return found;
}

export function kotlinSteps(source: string, owner: string): string[] {
	const lexed = tokens(source);
	const declaration = lexed.findIndex((token, index) => token.text === "interface" && lexed[index + 1]?.text === owner);
	const start = lexed.findIndex((token, index) => index > declaration && token.text === "{");
	const scope = declaration < 0 ? undefined : block(lexed, start, "{", "}");
	if (!scope) return [];
	const of = scope.body.findIndex((token, index) => token.text === "fun" && scope.body[index + 1]?.text === "of");
	if (of < 0) return [];
	const when = scope.body.findIndex((token, index) => index > of && token.text === "when");
	const selector = block(scope.body, when + 1, "(", ")");
	if (!selector?.body.some((token, index) => token.text === "getString" && selector.body[index + 2]?.kind === "string" && selector.body[index + 2]?.text === "action")) return [];
	const branches = block(scope.body, selector.end + 1, "{", "}");
	return branches ? labels(branches.body, "kotlin") : [];
}

export function kotlinKeys(source: string, map: string): string[] {
	const lexed = tokens(source);
	const declaration = lexed.findIndex((token, index) => token.text === "val" && lexed[index + 1]?.text === map);
	if (declaration < 0) return [];
	const start = lexed.findIndex((token, index) => index > declaration && token.text === "mapOf");
	const entries = block(lexed, start + 1, "(", ")");
	if (!entries) return [];
	const mapped = entries.body.filter((token, index) => token.kind === "string" && entries.body[index + 1]?.text === "to").map((token) => token.text);
	const comparisons = lexed.flatMap((token, index) => {
		if (token.kind !== "word" || token.text !== "key") return [];
		const operator = lexed.slice(index + 1, index + 3).map((part) => part.text).join("");
		const value = lexed[index + 3];
		return (operator === "!=" || operator === "==") && value?.kind === "string" ? [value.text] : [];
	});
	return [...new Set([...mapped, ...comparisons])];
}

export function swiftBranches(source: string, selector: "action" | "key"): string[] {
	const lexed = tokens(source);
	return lexed.flatMap((token, index) => {
		if (token.kind !== "word" || token.text !== "switch") return [];
		const start = lexed.findIndex((part, at) => at > index && part.kind === "symbol" && part.text === "{");
		const expression = lexed.slice(index + 1, start);
		if (!expression.some((part) => part.text === selector)) return [];
		const branches = block(lexed, start, "{", "}");
		return branches ? labels(branches.body, "swift") : [];
	});
}

export function coverage(platform: string, file: string, claimed: readonly string[], implemented: readonly string[], kind: "step" | "key"): string[] {
	if (!claimed.length || !implemented.length) return [`${platform} ${file} has no parsed ${kind} branches: parse its real dispatch before checking capabilities`];
	const declared = new Set(claimed);
	const actual = new Set(implemented);
	return [
		...[...declared].filter((name) => !actual.has(name)).map((name) => `${platform} claims ${name} but ${file} has no ${kind} case for it: implement it, or remove it from the capabilities`),
		...[...actual].filter((name) => !declared.has(name)).map((name) => `${platform} ${file} implements ${name} but its capabilities do not claim it: declare the ${kind} in the contract, or remove the dead branch`),
	];
}
