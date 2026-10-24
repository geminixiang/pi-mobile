import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [what = "read", steps = "[]", width = "1500"] = process.argv.slice(2);
if (!["read", "act", "on", "status"].includes(what)) throw new Error("usage: CDP_PORT=<port> node phone-screen.js read|act '<steps JSON>' [chars]|on <serial>|status");
const repo = fileURLToPath(new URL("../../../../", import.meta.url));

if (what === "on") {
	const adb = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
	execFileSync(adb, ["-s", steps, "shell", "settings", "put", "secure", "enabled_accessibility_services", "dev.geminixiang.pimobile/.PhoneScreenService"]);
	execFileSync(adb, ["-s", steps, "shell", "settings", "put", "secure", "accessibility_enabled", "1"]);
	process.exit(0);
}

const call = what === "status" ? "P.status()" : what === "read" ? "P.read()" : `P.act({ steps: ${steps} })`;
const script = `async () => {
	await until(() => window.Capacitor, 20000);
	const P = window.Capacitor.Plugins.PhoneScreen;
	const t = Date.now();
	const r = await ${call};
	if (!r.elements) return r;
	return { ms: Date.now() - t, done: r.done, error: r.error, app: r.app, keyboard: r.keyboard, slow: r.slow, shot: r.jpeg ? Math.round(r.jpeg.length * 0.75 / 1024) + " KB" : r.shotError, elements: r.elements.slice(0, ${Number(width)}) };
}`;
process.stdout.write(execFileSync("./test/ui.sh", [script], { cwd: repo, env: process.env, maxBuffer: 1 << 24 }).toString() + "\n");
