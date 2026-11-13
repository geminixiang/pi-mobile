import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Bench, benchOf, benchStep, emptyBench, FOLDER, fileKey, MAX_OPENED, pathOf } from "../src/workbench/bench.ts";
import { layoutAt, shownOverlay, WIDE_MIN_HEIGHT, WIDE_MIN_WIDTH } from "../src/workbench/layout.ts";
import { inViewNote, inViewPart, inViewPath } from "../src/workbench/note.ts";
import { changed, linesOf, partLabel } from "../src/workbench/changes.ts";

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

const css = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const wideQuery = `@media (min-width: ${WIDE_MIN_WIDTH}px) and (min-height: ${WIDE_MIN_HEIGHT}px)`;
assert.ok(css.includes(wideQuery), `styles.css centers sheets with ${wideQuery}; keep it equal to WIDE_MIN_WIDTH and WIDE_MIN_HEIGHT in src/workbench/layout.ts`);

console.log(`workbench: ${sizes.length} sizes, bench steps, in-view note with the part pointed at, changed lines`);
