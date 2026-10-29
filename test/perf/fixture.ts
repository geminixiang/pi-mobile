import { execFileSync } from "node:child_process";

const BOT = "測試效能";
const PROVIDER = { kind: "custom", id: "perf", name: "perf", baseUrl: "http://localhost:8399" };
const KEY = "capacitor-storage_provider.perf.apiKey";
const ANSWERS = 30;

const [command, serial] = process.argv.slice(2);
if ((command !== "setup" && command !== "teardown") || !serial) throw new Error("Usage: node test/perf/fixture.ts setup|teardown <adb serial>");

const ui = (body: string) => execFileSync("./test/device/ui.sh", [`async () => { ${body} }`], { encoding: "utf8", env: process.env });
const reloadAndWait = () => {
	ui(`setTimeout(() => location.reload(), 50); return true;`);
	execFileSync("sleep", ["6"]);
	ui(`await until(() => window.piRuntime && window.piController, 30000); return true;`);
};

if (command === "setup") {
	const adbPath = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
	execFileSync(adbPath, ["-s", serial, "reverse", "tcp:8399", "tcp:8399"]);
	const models = await fetch("http://127.0.0.1:8399/v1/models").then(
		(response) => response.ok,
		() => false,
	);
	if (!models) throw new Error("Start the fixture model first: node test/perf/server.ts");
	ui(`
		const settings = JSON.parse(localStorage["pi-mobile.settings"]);
		const providers = JSON.parse(settings.providers);
		if (!providers.some((p) => p.id === "perf")) providers.push(${JSON.stringify(PROVIDER)});
		settings.providers = JSON.stringify(providers);
		localStorage["pi-mobile.settings"] = JSON.stringify(settings);
		await window.Capacitor.Plugins.SecureStorage.internalSetItem({ prefixedKey: "${KEY}", data: JSON.stringify("perf"), sync: false, access: 0 });
		const bots = await window.piRuntime.bots();
		const id = bots.find((b) => b.name === "${BOT}")?.id ?? (await window.piRuntime.createBot({ name: "${BOT}", job: "", avatar: "🧪" }));
		localStorage["pi-mobile.lastBot"] = String(id);
		return id;
	`);
	reloadAndWait();
	console.log(
		ui(`
			const c = window.piController;
			await c.setModel("perf", "perf-fixture");
			await c.setThinking("off");
			const have = document.querySelectorAll(".answer").length;
			for (let n = have + 1; n <= ${ANSWERS}; n++) {
				await c.send([{ type: "text", text: "build " + n }]);
				await sleep(600);
				await until(() => !busy(), 30000);
				await sleep(200);
			}
			return { bot: c.id, answers: document.querySelectorAll(".answer").length };
		`),
	);
} else {
	console.log(
		ui(`
			const bots = await window.piRuntime.bots();
			const bot = bots.find((b) => b.name === "${BOT}");
			if (bot) await window.piRuntime.removeBot(bot.id);
			const settings = JSON.parse(localStorage["pi-mobile.settings"]);
			settings.providers = JSON.stringify(JSON.parse(settings.providers).filter((p) => p.id !== "perf"));
			if (settings.defaultProvider === "perf") delete settings.defaultProvider;
			localStorage["pi-mobile.settings"] = JSON.stringify(settings);
			localStorage.removeItem("pi-mobile.models:http://localhost:8399");
			await window.Capacitor.Plugins.SecureStorage.internalRemoveItem({ prefixedKey: "${KEY}", sync: false });
			if (bot && localStorage["pi-mobile.lastBot"] === String(bot.id)) localStorage.removeItem("pi-mobile.lastBot");
			return { removed: bot?.id ?? null };
		`),
	);
	reloadAndWait();
}
