import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { Page } from "../../../test/device/page.ts";

const directory = ".shots/errands";
mkdirSync(directory, { recursive: true });
const adb = (...args) => execFileSync("adb", ["-s", "emulator-5554", ...args], { encoding: "utf8" });
const shell = (...args) => adb("shell", ...args);
const pid = shell("pidof", "dev.geminixiang.pimobile").trim();
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
const page = await Page.connect("9333");
const results = [];
const call = async (plugin, method, args = {}) => {
    const start = performance.now();
    const result = await page.eval(`return await window.Capacitor.nativePromise(${JSON.stringify(plugin)}, ${JSON.stringify(method)}, ${JSON.stringify(args)});`);
    const record = { plugin, method, args, ms: Math.round(performance.now() - start), result };
    results.push(record);
    writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2));
    console.log(`${method} ${record.ms}ms done=${result.done ?? "-"} ${result.error ?? ""}`);
    return result;
};
const read = (display) => call("PhoneScreen", "read", { display, screenshot: false });
const act = (display, steps, note) => call("PhoneScreen", "act", { display, steps, note, screenshot: false });
const idOf = (snapshot, text) => {
    const line = snapshot.elements.split("\n").find((line) => line.includes(`text "${text}"`));
    assert.ok(line, `missing ${text}`);
    return Number(line.slice(1, line.indexOf("]")));
};

try {
    for (let run = 0; run < 3; run++) {
        await call("AgentScreen", "close");
        const opened = await call("AgentScreen", "open");
        assert.equal(opened.ok, true);
        const batch = await act(opened.display, [
            { action: "open", app: "com.android.settings" },
            { action: "tap", text: "Display & touch" },
            { action: "wait_for", text: "Brightness level", gone: false, ms: 3000 },
            { action: "scroll_to", text: "Colors", direction: "down" },
            { action: "tap", text: "Colors" },
            { action: "expect", app: "com.android.settings", text: "Colors" },
            { action: "key", key: "back" },
        ], "查看顏色設定");
        assert.equal(batch.done, 7);
        assert.equal(batch.error, undefined);
        assert.ok(batch.did.some((line) => line.includes('"Colors"')));
        assert.ok(shell("dumpsys", "window").includes("mTopFocusedDisplayId=0"));
    }
    const { display } = await call("AgentScreen", "open");
    writeFileSync(`${directory}/note.png`, execFileSync("adb", ["-s", "emulator-5554", "exec-out", "screencap", "-p"]));
    const front = await read(0);
    assert.ok(front.elements.includes("查看顏色設定"), "preview must show the supplied words");
    const own = await read(display);
    const again = await read(display);
    assert.equal(idOf(own, "Colors"), idOf(again, "Colors"));
    await read(0);
    const unchanged = await act(display, [{ action: "expect", app: "Settings" }]);
    assert.equal(unchanged.unchanged, true, "reading another display must not replace this display's history");
    assert.equal(unchanged.delta, true);
    assert.equal(unchanged.elements, "");
    const tapped = await act(display, [{ action: "tap", id: idOf(again, "Colors") }]);
    assert.equal(tapped.done, 1);
    const stale = await act(display, [{ action: "tap", id: idOf(again, "Colors") }, { action: "key", key: "back" }]);
    assert.equal(stale.done, 0);
    assert.ok(stale.error.includes("target_gone"));
    const absent = await act(display, [{ action: "wait_for", text: "pi-errands-absent", gone: true, ms: 300 }]);
    assert.equal(absent.done, 1);
    const timeout = await act(display, [{ action: "wait_for", text: "pi-errands-absent", gone: false, ms: 300 }, { action: "key", key: "back" }]);
    assert.equal(timeout.done, 0);
    assert.ok(timeout.error.includes("wait_timeout"));
    for (const expectation of [{ app: "missing.app" }, { text: "pi-errands-absent" }]) {
        const failed = await act(display, [{ action: "expect", ...expectation }, { action: "key", key: "back" }]);
        assert.equal(failed.done, 0);
        assert.ok(failed.error.includes("expect_"));
    }
    const missing = await act(display, [{ action: "tap", text: "pi-errands-absent" }, { action: "key", key: "back" }]);
    assert.equal(missing.done, 0);
    assert.ok(missing.error.includes("target_missing"));
    await act(display, [{ action: "key", key: "back" }]);
    const end = await act(display, [{ action: "scroll_to", text: "pi-errands-absent", direction: "down" }, { action: "key", key: "back" }]);
    assert.equal(end.done, 0);
    assert.ok(end.error.includes("scroll_end"));
    const bottom = await read(display);
    assert.ok(!bottom.elements.includes("more below"), "scroll_end must not stop at a collapsed header while its child list can still scroll");
    shell("am", "start", "-n", "com.android.settings/.Settings");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const timings = [];
    for (const busy of [false, true, false, true, false, true]) {
        const activity = busy ? promisify(execFile)("adb", ["-s", "emulator-5554", "shell", "for i in 1 2 3 4 5 6; do input -d 0 swipe 200 1700 200 600 250; input -d 0 swipe 200 600 200 1700 250; done"]) : Promise.resolve();
        const start = performance.now();
        const result = await act(display, [{ action: "tap", x: 270, y: 37 }]);
        timings.push({ busy, ms: Math.round(performance.now() - start) });
        assert.equal(result.done, 1);
        await activity;
    }
    writeFileSync(`${directory}/settle.json`, JSON.stringify(timings, null, 2));
    console.log("PASS: three multi-screen batches, text/id/coordinate taps, stale target, waits, batch stops, bounded search, per-display history and preview note", timings);
} finally {
    await call("AgentScreen", "close");
    shell("am", "start", "-n", "dev.geminixiang.pimobile/.MainActivity");
    page.close();
}
