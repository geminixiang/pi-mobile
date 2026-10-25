import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const adb = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const PI = "dev.geminixiang.pimobile";

export function keepPiInFront() {
	if (!process.env.ANDROID_SERIAL) return () => {};
	let stopped = false;
	const tick = async () => {
		while (!stopped) {
			const [focus, services] = await Promise.all([
				run(adb, ["shell", "dumpsys", "window"]).then((r) => r.stdout.match(/mCurrentFocus=.*/)?.[0] ?? ""),
				run(adb, ["shell", "dumpsys", "activity", "services", PI]).then((r) => r.stdout),
			]).catch(() => ["", "AgentService"]);
			if (!focus.includes(PI) && !services.includes("AgentService")) await run(adb, ["shell", "am", "start", "-n", `${PI}/.MainActivity`]).catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 5000));
		}
	};
	void tick();
	return () => {
		stopped = true;
	};
}
