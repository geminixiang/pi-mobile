import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const helpers = readFileSync(new URL("./ui.js", import.meta.url), "utf8").replace("export {};", "");

const page = `
const FIRST = "測試草稿甲";
const SECOND = "測試草稿乙";
const SENDER = "測試效能";
const composerInput = () => document.querySelector(".composer input[type=file][multiple]");
const pick = (files) => {
	const transfer = new DataTransfer();
	for (const file of files) transfer.items.add(file);
	const input = composerInput();
	input.files = transfer.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
};
const csv = (name, rows) => new File([Array.from({ length: rows }, (_, i) => i + ",name" + i + "," + i * 3).join("\\n")], name, { type: "text/csv" });
const picture = async (name, edge) => {
	const canvas = document.createElement("canvas");
	canvas.width = edge;
	canvas.height = edge;
	const context = canvas.getContext("2d");
	for (let i = 0; i < 200; i++) {
		context.fillStyle = "hsl(" + i * 7 + ",70%,50%)";
		context.fillRect((i * 997) % edge, (i * 389) % edge, edge / 4, edge / 4);
	}
	return new File([await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))], name, { type: "image/png" });
};
const chips = () => [...document.querySelectorAll(".pending-files .file-chip")].map((chip) => chip.querySelector(".file-chip-name").textContent + (chip.textContent.includes("讀取中") ? " (讀取中)" : ""));
const thumbs = () => document.querySelectorAll(".pending-images .thumb").length;
const problem = () => document.querySelector(".composer-problem")?.textContent ?? "";
const stored = (id) =>
	new Promise((resolve, reject) => {
		const opened = indexedDB.open("pi-drafts", 1);
		opened.onerror = () => reject(opened.error);
		opened.onsuccess = () => {
			const read = opened.result.transaction("attachments", "readonly").objectStore("attachments").get(String(id));
			read.onsuccess = () => resolve(read.result ? { images: read.result.images.length, files: read.result.files.map((file) => file.card.name) } : { images: 0, files: [] });
		};
	});
const idOf = async (name) => (await window.piRuntime.bots()).find((bot) => bot.name === name)?.id;
const open = async (name) => {
	const id = await idOf(name);
	[...document.querySelectorAll(".drawer-open")].find((item) => item.textContent.includes(name)).click();
	if (!(await until(() => window.piController?.id === id && composerInput(), 10000))) throw new Error("could not open " + name);
	return id;
};
const empty = async () => {
	for (const chip of [...document.querySelectorAll(".pending-files .file-chip")]) {
		chip.click();
		await sleep(50);
	}
	while (thumbs()) {
		document.querySelector(".pending-images .thumb").click();
		await sleep(50);
	}
	await sleep(300);
};
const ready = (name) => until(() => chips().includes(name), 60000);
const failures = [];
const expect = (scenario, ok, seen) => {
	if (!ok) failures.push(scenario + ": " + JSON.stringify(seen));
};
const view = async (id) => ({ chips: chips(), thumbs: thumbs(), problem: problem(), stored: await stored(id) });

const created = [];
for (const name of [FIRST, SECOND]) if (!(await idOf(name))) created.push(await window.piRuntime.createBot({ name, job: "", avatar: "coder" }));
await sleep(500);
const first = await open(FIRST);
await empty();

pick([csv("返回.csv", 300000)]);
await sleep(300);
await open(SECOND);
await sleep(300);
await open(FIRST);
const whileReading = chips();
await until(() => chips().includes("返回.csv"), 60000);
await sleep(500);
const back = await view(first);
expect("a file read while away and back shows once, once it is read", JSON.stringify(whileReading) === "[]" && JSON.stringify(back.chips) === '["返回.csv"]' && back.stored.files.join() === "返回.csv" && !back.problem, { whileReading, back });
await empty();

pick([csv("移除.csv", 300000)]);
await sleep(300);
document.querySelector(".pending-files .file-chip").click();
await sleep(6000);
const removed = await view(first);
expect("a file removed while it is read does not come back", removed.chips.length === 0 && removed.stored.files.length === 0, removed);

pick([csv("移除後離開.csv", 300000)]);
await sleep(300);
document.querySelector(".pending-files .file-chip").click();
await open(SECOND);
await sleep(6000);
await open(FIRST);
await sleep(500);
const removedAway = await view(first);
expect("a file removed while it is read, then left, does not come back", removedAway.chips.length === 0 && removedAway.stored.files.length === 0, removedAway);

pick([csv("背景甲.csv", 60000), csv("背景乙.csv", 60000), csv("背景丙.csv", 60000)]);
await sleep(150);
await open(SECOND);
await sleep(6000);
const away = await stored(first);
await open(FIRST);
await sleep(800);
const background = await view(first);
const all = (names) => [...names].sort().join();
expect("files read while away are all kept once each (in the order they finish)", all(away.files) === all(["背景甲.csv", "背景乙.csv", "背景丙.csv"]) && all(background.chips) === all(away.files), { away, background });
await empty();

const photo = await picture("轉換中.png", 8000);
pick([photo]);
await open(SECOND);
await sleep(3000);
const photoAway = await stored(first);
await open(FIRST);
await sleep(800);
const photoBack = await view(first);
expect("a photo still converting when you leave is kept", photoAway.images === 1 && photoBack.thumbs === 1 && photoBack.stored.images === 1, { photoAway, photoBack });
await empty();

pick([csv("留著甲.csv", 2000), csv("留著乙.csv", 2000)]);
await ready("留著甲.csv");
await ready("留著乙.csv");
pick([await picture("留著.png", 1200)]);
await until(() => thumbs() > 0);
await sleep(300);
await open(SECOND);
await sleep(300);
await open(FIRST);
await sleep(800);
const kept = await view(first);
expect("an unsent draft is kept, in order, after leaving", kept.chips.join() === "留著甲.csv,留著乙.csv" && kept.thumbs === 1 && kept.stored.images === 1, kept);
await empty();

const sender = await idOf(SENDER);
const skipped = [];
if (sender) {
	await open(SENDER);
	await empty();
	pick([csv("送出.csv", 2000)]);
	await ready("送出.csv");
	pick([await picture("送出.png", 1200)]);
	await until(() => thumbs() > 0);
	type("草稿附件測試");
	await sleep(100);
	click("送出");
	await sleep(500);
	await until(() => !busy(), 30000);
	await open(SECOND);
	await sleep(300);
	await open(SENDER);
	await sleep(800);
	const sent = await view(sender);
	expect("what was sent does not come back", sent.chips.length === 0 && sent.thumbs === 0 && sent.stored.files.length === 0 && sent.stored.images === 0, sent);
} else skipped.push("sending (needs the 測試效能 bot from test/perf/fixture.ts, so no real model is called)");

await open(FIRST);
await empty();
for (const id of created) await window.piRuntime.removeBot(id);
return { failures, skipped };
`;

const output = execFileSync("node", ["test/device/cdp.ts", `(async () => { ${helpers}\n${page} })()`], { encoding: "utf8", env: process.env, maxBuffer: 1 << 24 });
const result = JSON.parse(output);
if (typeof result !== "object" || !result?.failures) {
	console.error(output);
	process.exit(1);
}
for (const note of result.skipped) console.log(`skip: ${note}`);
if (result.failures.length > 0) {
	console.error(`FAIL:\n- ${result.failures.join("\n- ")}`);
	process.exit(1);
}
console.log("PASS: draft attachments survive leaving a bot mid-read once each, are not revived once removed or sent, and an unsent draft keeps its order; a photo still converting when you leave is kept");
