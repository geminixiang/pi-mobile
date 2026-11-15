import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { Page } from "../../../test/device/page.ts";

const directory = ".shots/preview";
mkdirSync(directory, { recursive: true });
const adb = (...args) => execFileSync("adb", ["-s", process.env.SERIAL ?? "emulator-5554", ...args], { encoding: "utf8" });
const shell = (...args) => adb("shell", ...args);
const pid = shell("pidof", "dev.geminixiang.pimobile").trim();
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
const page = await Page.connect();
const started = shell("date '+%m-%d %H:%M:%S.000'").trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (plugin, method, args = {}) => page.eval(`return await window.Capacitor.nativePromise(${JSON.stringify(plugin)}, ${JSON.stringify(method)}, ${JSON.stringify(args)});`);
const shot = (name) => writeFileSync(`${directory}/${name}.png`, execFileSync("adb", ["-s", process.env.SERIAL ?? "emulator-5554", "exec-out", "screencap", "-p"], { maxBuffer: 8 * 1024 * 1024 }));
const record = (name, value) => writeFileSync(`${directory}/${name}.json`, JSON.stringify(value, null, 2));
const BOUNDS = /bounds=Rect\((\d+), (\d+) - (\d+), (\d+)\)/;
const TASK = /RootTask id=(\d+) .* displayId=(\d+) /;

function overlay() {
    const line = shell("dumpsys", "accessibility").split("\n").find((line) => line.includes("A11yWindow[") && line.includes("背景螢幕預覽"));
    const match = line?.match(BOUNDS);
    return match ? match.slice(1).map(Number) : undefined;
}

function task(display) {
    const listing = shell("am", "stack", "list");
    const block = listing.split("\n\n").find((block) => Number(block.match(TASK)?.[2]) === display && block.includes("visible=true") && block.includes("com.android.settings"));
    assert.ok(block, `Settings must be visible on display ${display}`);
    return { id: Number(block.match(TASK)?.[1]), block };
}

async function open() {
    await call("AgentScreen", "close");
    const opened = await call("AgentScreen", "open");
    assert.equal(opened.ok, true);
    const result = await call("PhoneScreen", "act", { display: opened.display, screenshot: false, steps: [{ action: "open", app: "com.android.settings" }] });
    assert.equal(result.done, 1);
    assert.equal(result.package, "com.android.settings");
    await pause(1500);
    assert.ok(overlay(), "opening a background display must show its preview");
    return opened.display;
}

try {
    shell("input", "keyevent", "KEYCODE_HOME");
    const displays = [];
    for (let run = 0; run < 3; run++) displays.push(await open());
    const display = displays.at(-1);
    const result = await call("PhoneScreen", "act", { display, screenshot: false, steps: [{ action: "tap", x: 270, y: 302 }] });
    assert.ok(result.elements.includes("Network & internet"), "normalized coordinates must reach the intended Settings page");
    const before = task(display);
    record("task-before", before);
    shot("overlay-home");
    const bounds = overlay();
    assert.ok(bounds);
    shell("input", "swipe", String(bounds[0] + 80), String(bounds[1] + 100), "90", "250", "400");
    await pause(300);
    const moved = overlay();
    assert.ok(moved && moved[0] < bounds[0] && moved[1] < bounds[1], "drag must move the preview to the opposite corner");
    shot("dragged");
    const focus = shell("dumpsys", "window");
    assert.ok(focus.includes("mTopFocusedDisplayId=0"));
    assert.ok(focus.split("\n").some((line) => line.includes("mCurrentFocus") && line.includes("nexuslauncher")), "preview must not take focus from Home");
    writeFileSync(`${directory}/focus.txt`, focus);
    shell("input", "swipe", "550", "1900", "550", "700", "400");
    shot("outside-touch");
    assert.equal(task(display).id, before.id, "touches outside the overlay must not take over");
    shell("input", "tap", String((moved[0] + moved[2]) / 2), String((moved[1] + moved[3]) / 2));
    await pause(1500);
    assert.equal(overlay(), undefined);
    const after = task(0);
    assert.equal(after.id, before.id, "takeover must move the existing task, not relaunch Settings");
    record("task-after", after);
    const front = await call("PhoneScreen", "read", { display: 0, screenshot: false });
    assert.ok(front.elements.includes("Network & internet"), "takeover must preserve the current page");
    shot("taken-over");
    const stopped = await call("PhoneScreen", "act", { display, screenshot: false, steps: [{ action: "tap", x: 270, y: 302 }] });
    assert.equal(stopped.done, 0);
    assert.equal(stopped.error, "taken_over");
    assert.equal((await call("PhoneScreen", "read", { display, screenshot: false })).error, "taken_over");
    assert.equal((await call("AgentScreen", "open")).display, display, "tool retries must not create a fresh background session after takeover");
    record("taken-over-outcome", stopped);
    shell("input", "keyevent", "KEYCODE_HOME");
    const hidden = await open();
    const visible = overlay();
    shell("input", "tap", String(visible[2] - 50), String(visible[3] - 50));
    await pause(500);
    assert.equal(overlay(), undefined);
    const continued = await call("PhoneScreen", "act", { display: hidden, screenshot: false, steps: [{ action: "tap", x: 270, y: 302 }] });
    assert.equal(continued.done, 1);
    assert.ok(continued.elements.includes("Network & internet"));
    await call("AgentScreen", "open");
    assert.equal(overlay(), undefined, "hiding must persist through the next bot tool call");
    record("hidden-bot-continues", continued);
    shot("hidden");
    await call("AgentScreen", "close");
    await pause(1000);
    const shutdown = adb("logcat", "-d", "-T", started, "-s", "AndroidRuntime");
    writeFileSync(`${directory}/shutdown-log.txt`, shutdown);
    assert.ok(!shutdown.includes("FATAL EXCEPTION"), "the shell must finish display/codec cleanup before app_process exits");
    writeFileSync(`${directory}/integration-log.txt`, adb("logcat", "-d", "-T", started, "-s", "AgentPreview"));
    console.log("PASS: 3 starts; low-resolution coordinates; main focus; drag; outside touch; same-task/same-page takeover; named read/act outcomes; retry gate; hide keeps bot working; close.");
} finally {
    page.close();
}
