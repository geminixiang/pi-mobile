import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Bench, benchOf, benchStep, emptyBench, FOLDER, fileKey, MAX_OPENED, pathOf } from "../src/workbench/bench.ts";
import { layoutAt, shownOverlay, WIDE_MIN_HEIGHT, WIDE_MIN_WIDTH } from "../src/workbench/layout.ts";
import { inViewNote, inViewPart, inViewPath } from "../src/agent/in-view.ts";
import type { Element, Root } from "hast";
import { type BlockMarks, changed, linesOf, markBlocks, partLabel } from "../src/workbench/changes.ts";

const sizes: [string, number, number, ReturnType<typeof layoutAt>][] = [
	["Galaxy S24", 360, 780, "phone"],
	["Galaxy S24 Ultra", 412, 915, "phone"],
	["S24 Ultra on its side", 915, 412, "phone"],
	["iPhone Pro Max on its side", 956, 440, "phone"],
	["iPad mini, portrait", 744, 1133, "stacked"],
	["iPad Air 11, portrait", 820, 1180, "stacked"],
	["iPad Pro 11, portrait", 834, 1210, "stacked"],
	["Galaxy Z Fold inner screen", 690, 829, "stacked"],
	["foldable in the mockup", 884, 1104, "columns"],
	["iPad Air 11, landscape", 1180, 820, "columns"],
	["iPad mini, landscape", 1133, 744, "columns"],
	["iPad Pro 13, portrait", 1032, 1376, "columns"],
	["iPad Pro 13, landscape", 1376, 1032, "columns"],
];
for (const [name, width, height, layout] of sizes) assert.equal(layoutAt(width, height), layout, name);

assert.equal(shownOverlay("drawer", "phone"), "drawer");
assert.equal(shownOverlay("workspace", "phone"), "workspace");
for (const only of ["drawer", "workspace"]) assert.equal(shownOverlay(only, "columns"), undefined, only);
for (const both of ["settings", "model", "panel", "botMemory"]) assert.equal(shownOverlay(both, "stacked"), both, both);

const show = (bench: Bench, key: string, bot = "1") => benchStep(bench, { type: "show", bot, key });
const close = (bench: Bench, key: string, bot = "1") => benchStep(bench, { type: "close", bot, key });

const start = emptyBench("1");
assert.equal(start.pick, undefined);
assert.deepEqual(start.opened, []);

const one = show(start, fileKey("a.html"));
assert.equal(pathOf(one.pick), "a.html");
const two = show(one, fileKey("b.md"));
assert.deepEqual(two.opened, ["a.html", "b.md"]);
assert.equal(pathOf(two.pick), "b.md");

const again = show(two, fileKey("a.html"));
assert.deepEqual(again.opened, ["b.md", "a.html"], "a file opened again moves to the end, not in twice");

const folder = show(two, FOLDER);
assert.equal(folder.pick, FOLDER);
assert.equal(pathOf(folder.pick), undefined);
assert.deepEqual(folder.opened, two.opened, "showing the folder keeps the opened files");

assert.equal(close(two, fileKey("b.md")).pick, undefined, "closing the file on stage leaves nothing picked");
assert.deepEqual(close(two, fileKey("b.md")).opened, ["a.html"]);
assert.equal(close(two, fileKey("a.html")).pick, fileKey("b.md"), "closing another file keeps the one picked");
assert.equal(close(show(two, "ask:1"), "ask:1").pick, undefined);
assert.deepEqual(close(show(two, "ask:1"), "ask:1").opened, two.opened, "closing a card that is not a file keeps the opened files");

assert.equal(benchOf(two, "1"), two);
assert.deepEqual(benchOf(two, "2"), emptyBench("2"), "another bot starts empty");
assert.deepEqual(show(two, fileKey("c.md"), "2").opened, ["c.md"], "opening a file for another bot drops the first bot's files");

const crowded = Array.from({ length: MAX_OPENED + 2 }, (_, index) => fileKey(`${index}.md`)).reduce((bench, key) => show(bench, key), start);
assert.equal(crowded.opened.length, MAX_OPENED);
assert.ok(!crowded.opened.includes("0.md"), "the oldest file goes first");

for (const path of ["/root/bots/a/職缺比較.html", "notes/a b.md", 'odd"name>.md']) assert.equal(inViewPath(inViewNote(path).text), path);
assert.equal(inViewPath("<in-view>\nunfinished"), undefined);
assert.equal(inViewPart(inViewNote("a.html").text), undefined);
assert.equal(inViewPart(inViewNote("a.html", "精藤 140–170 萬 捷運 25 分").text), "精藤 140–170 萬 捷運 25 分", "the part the user pointed at goes with the note");
assert.equal(inViewPath(inViewNote("a.html", "x").text), "a.html");
assert.equal(partLabel("精藤 平台暨後端工程師 140–170 萬 台北"), "「精藤 平台暨後端工程師 14…」");

assert.deepEqual([...changed(["a", "b", "c"], ["a", "b", "c"])], [], "nothing changed, nothing marked");
assert.deepEqual([...changed(["a", "b", "c"], ["a", "B", "c"])], [1], "a changed line is marked");
assert.deepEqual([...changed(["a", "b", "c"], ["a", "x", "b", "c"])], [1], "an inserted line is marked and the lines after it are not");
assert.deepEqual([...changed(["a", "b", "c"], ["a", "c"])], [], "a removed line marks nothing left");
assert.deepEqual([...changed(linesOf("一\n二\n"), linesOf("一\n二\n三\n"))], [2]);
assert.equal(inViewPath("look at <in-view>\nx\n</in-view>"), undefined);

const at = (line: number) => ({ start: { line, column: 1 }, end: { line, column: 1 } });
const element = (tagName: string, line: number, children: Element["children"]): Element => ({ type: "element", tagName, properties: {}, children, position: at(line) });
const word = (value: string) => ({ type: "text" as const, value });
const marked = (marks: Omit<BlockMarks, "parts">) => {
	const tree: Root = {
		type: "root",
		children: [
			element("h2", 1, [word("職缺")]),
			element("p", 3, [word("薪水 "), element("strong", 3, [word("140")]), word(" 萬")]),
			element("ul", 5, [element("li", 5, [element("p", 5, [word("台北")]), element("p", 6, [word("捷運 25 分")])])]),
			element("table", 8, [element("tbody", 8, [element("tr", 8, [element("td", 8, [word("精藤")]), element("td", 8, [word("後端")])])])]),
		],
	};
	const parts: string[] = [];
	markBlocks({ ...marks, parts })()(tree);
	const blocks: Element[] = [];
	const collect = (node: Root | Root["children"][number]) => {
		if (node.type === "element" && node.properties.dataBlock !== undefined) blocks.push(node);
		if ("children" in node) node.children.forEach(collect);
	};
	collect(tree);
	return { parts, classes: blocks.map((block) => [block.tagName, block.properties.dataBlock, block.properties.className]) };
};
const plain = marked({ changed: new Set(), picked: undefined });
assert.deepEqual(plain.parts, ["職缺", "薪水 140 萬", "台北 捷運 25 分", "台北", "捷運 25 分", "精藤 後端"], "a block's part is its text, spaced between blocks and cells and joined within a line");
assert.deepEqual(plain.classes.map(([tag, index, classes]) => [tag, index, classes]), [["h2", 0, undefined], ["p", 1, undefined], ["li", 2, undefined], ["p", 3, undefined], ["p", 4, undefined], ["tr", 5, undefined]]);
const pointed = marked({ changed: new Set([2]), picked: "精藤 後端" });
assert.deepEqual(pointed.classes.filter(([, , classes]) => classes !== undefined), [["p", 1, ["changed"]], ["tr", 5, ["picked"]]], "the changed line and the part pointed at are marked while rendering");

const css = readFileSync(new URL("../packages/pi-mobile-ui/src/styles/looks.css", import.meta.url), "utf8");
const wideQuery = `@media (min-width: ${WIDE_MIN_WIDTH}px) and (min-height: ${WIDE_MIN_HEIGHT}px)`;
assert.ok(css.includes(wideQuery), `looks.css in pi-mobile-ui centers sheets with ${wideQuery}; keep it equal to WIDE_MIN_WIDTH and WIDE_MIN_HEIGHT in src/workbench/layout.ts`);

console.log(`workbench: ${sizes.length} sizes, bench steps, in-view note with the part pointed at, changed lines`);
