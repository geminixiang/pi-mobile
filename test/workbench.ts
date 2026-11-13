import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOT_TAB, benchOf, benchStep, emptyBench, inView, keyOf, MAX_TABS, type Tab } from "../src/workbench/bench.ts";
import { layoutAt, shownOverlay, WIDE_MIN_HEIGHT, WIDE_MIN_WIDTH } from "../src/workbench/layout.ts";
import { inViewNote, inViewPath } from "../src/workbench/note.ts";

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
for (const only of ["drawer", "panel", "workspace"]) assert.equal(shownOverlay(only, "columns"), undefined, only);
for (const both of ["settings", "model", "botMemory"]) assert.equal(shownOverlay(both, "stacked"), both, both);

const file = (path: string): Tab => ({ kind: "file", path });
const show = (bench: ReturnType<typeof emptyBench>, tab: Tab, bot = "1") => benchStep(bench, { type: "show", bot, tab });
const close = (bench: ReturnType<typeof emptyBench>, tab: Tab, bot = "1") => benchStep(bench, { type: "close", bot, key: keyOf(tab) });

const start = emptyBench("1");
assert.deepEqual(start.tabs, [BOT_TAB]);
assert.equal(inView(start), undefined);

const one = show(start, file("a.html"));
assert.equal(inView(one), "a.html");
const two = show(one, file("b.md"));
assert.deepEqual(two.tabs.map(keyOf), ["bot", "file:a.html", "file:b.md"]);
assert.equal(inView(two), "b.md");

const again = show(two, file("a.html"));
assert.equal(again.tabs.length, 3, "a file already open is not opened twice");
assert.equal(inView(again), "a.html");

assert.equal(inView(show(two, BOT_TAB)), undefined, "the bot tab shows no file");
assert.equal(show(two, BOT_TAB).tabs.length, 3);

const folder = show(two, { kind: "folder" });
assert.equal(folder.active, "folder");
assert.equal(inView(folder), undefined);

assert.equal(inView(close(two, file("b.md"))), "a.html", "closing the last tab shows the one before it");
assert.equal(inView(close(again, file("a.html"))), "b.md", "closing a middle tab shows the one after it");
assert.equal(inView(close(two, file("a.html"))), "b.md", "closing a tab in the background keeps the one in view");
assert.equal(close(show(start, file("a.html")), file("a.html")).active, "bot");
assert.equal(close(two, BOT_TAB), two, "the bot tab cannot be closed");
assert.equal(close(two, file("missing")), two);

assert.equal(benchOf(two, "1"), two);
assert.deepEqual(benchOf(two, "2"), emptyBench("2"), "another bot starts with its own tab only");
assert.deepEqual(show(two, file("c.md"), "2").tabs.map(keyOf), ["bot", "file:c.md"], "opening a file for another bot drops the first bot's tabs");

const crowded = Array.from({ length: MAX_TABS + 2 }, (_, index) => file(`${index}.md`)).reduce((bench, tab) => show(bench, tab), start);
assert.equal(crowded.tabs.length, MAX_TABS);
assert.equal(crowded.tabs[0], BOT_TAB, "the bot tab stays when files crowd the bench");
assert.equal(inView(crowded), `${MAX_TABS + 1}.md`);
assert.ok(!crowded.tabs.some((tab) => keyOf(tab) === "file:0.md"), "the oldest file goes first");

for (const path of ["/root/bots/a/職缺比較.html", "notes/a b.md", 'odd"name>.md']) assert.equal(inViewPath(inViewNote(path).text), path);
assert.equal(inViewPath("<in-view>\nunfinished"), undefined);
assert.equal(inViewPath("look at <in-view>\nx\n</in-view>"), undefined);

const css = readFileSync(new URL("../src/app/styles.css", import.meta.url), "utf8");
const wideQuery = `@media (min-width: ${WIDE_MIN_WIDTH}px) and (min-height: ${WIDE_MIN_HEIGHT}px)`;
assert.ok(css.includes(wideQuery), `styles.css centers sheets with ${wideQuery}; keep it equal to WIDE_MIN_WIDTH and WIDE_MIN_HEIGHT in src/workbench/layout.ts`);

console.log(`workbench: ${sizes.length} sizes, bench steps, in-view note`);
