import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { Page } from "../../../test/device/page.ts";

const execute = promisify(execFile);
const directory = process.env.OUT ?? ".shots/preview";
const adb = (...args) => execFileSync("adb", ["-s", process.env.SERIAL ?? "emulator-5554", ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const shell = (...args) => adb("shell", ...args);
const app = shell("pidof", "dev.geminixiang.pimobile").trim();
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${app}`);
const page = await Page.connect();
const started = shell("date '+%m-%d %H:%M:%S.000'").trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (plugin, method, args = {}) => page.eval(`return await window.Capacitor.nativePromise(${JSON.stringify(plugin)}, ${JSON.stringify(method)}, ${JSON.stringify(args)});`);
const BOUNDS = /bounds=Rect\((\d+), (\d+) - (\d+), (\d+)\)/;
const summaries = [];

async function open() {
    await call("AgentScreen", "close");
    const opened = await call("AgentScreen", "open");
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    await call("PhoneScreen", "act", { display: opened.display, screenshot: false, steps: [{ action: "open", app: "com.android.settings" }] });
    await pause(4000);
    return opened.display;
}

async function sample(run, phase, display) {
    const processes = shell("ps", "-A", "-o", "PID,ARGS");
    const server = processes.split("\n").find((line) => line.includes("dev.geminixiang.agentscreen.DisplayServer") && !line.includes("sh -c"))?.trim().split(/\s+/)[0];
    const codec = shell("pidof", "media.swcodec").trim();
    if (!server) throw new Error("DisplayServer is missing");
    const ids = [app, server, codec];
    const tag = `${run}-${phase}`;
    writeFileSync(`${directory}/${tag}-processes.txt`, processes);
    for (const [name, pid] of [["pi", app], ["shell", server], ["codec", codec]]) {
        writeFileSync(`${directory}/${tag}-${name}-memory.txt`, shell("dumpsys", "meminfo", "-s", pid));
    }
    const top = execute("adb", ["-s", process.env.SERIAL ?? "emulator-5554", "shell", "top", "-b", "-d", "1", "-n", "21", "-p", ids.join(","), "-o", "PID,%CPU,RES,ARGS"]);
    const motion = phase === "moving" ? execute("adb", ["-s", process.env.SERIAL ?? "emulator-5554", "shell", `for i in $(seq 1 12); do input -d ${display} swipe 176 650 176 200 800; input -d ${display} swipe 176 200 176 650 800; done`]) : Promise.resolve();
    const [result] = await Promise.all([top, motion]);
    writeFileSync(`${directory}/${tag}-top.txt`, result.stdout);
    const rows = result.stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter((fields) => ids.includes(fields[0]));
    const stats = Object.fromEntries(ids.map((pid, index) => {
        const cpu = rows.filter((fields) => fields[0] === pid).slice(1).map((fields) => Number(fields[1]));
        return [["pi", "shell", "codec"][index], { pid, samples: cpu.length, meanCpu: cpu.reduce((a, b) => a + b, 0) / cpu.length, maxCpu: Math.max(...cpu) }];
    }));
    summaries.push({ run, phase, display, stats });
    writeFileSync(`${directory}/measurements.json`, JSON.stringify(summaries, null, 2));
    writeFileSync(`${directory}/measurement-log.txt`, adb("logcat", "-d", "-T", started, "-s", "AgentPreview"));
    console.log(JSON.stringify(summaries.at(-1)));
}

try {
    shell("input", "keyevent", "KEYCODE_HOME");
    for (let run = 1; run <= 3; run++) {
        shell("input", "keyevent", "KEYCODE_HOME");
        const idle = await open();
        await sample(run, "still", idle);
        const line = shell("dumpsys", "accessibility").split("\n").find((line) => line.includes("A11yWindow[") && line.includes("背景螢幕預覽"));
        const bounds = line?.match(BOUNDS)?.slice(1).map(Number);
        if (!bounds) throw new Error("Preview is missing");
        shell("input", "tap", String(bounds[2] - 50), String(bounds[3] - 50));
        await pause(1000);
        await sample(run, "hidden", idle);
        const moving = await open();
        await sample(run, "moving", moving);
        shell("am", "start", "-n", "dev.geminixiang.pimobile/.MainActivity");
        await call("AgentScreen", "close");
    }
    writeFileSync(`${directory}/measurements.json`, JSON.stringify(summaries, null, 2));
    writeFileSync(`${directory}/measurement-log.txt`, adb("logcat", "-d", "-T", started, "-s", "AgentPreview"));
} finally {
    page.close();
}
