import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choicesOf, keysCommand, LIST, placeOf, readCommand, reading, sendCommand, sendProblem, workers } from "../src/computer-agents/workers.ts";
import { startJob } from "../src/jobs/commands.ts";
import { parseAgentId, reachAgent } from "../src/computer-agents/reach.ts";
import { HostCommands } from "../src/computer/commands.ts";
import type { PairedHost } from "../src/computer/pairing.ts";

const herdrAgent = { agent: "claude", agent_status: "blocked", cwd: "/Users/me/app", focused: true, name: "tester", pane_id: "w1:p1", terminal_title_stripped: "Claude Code", workspace_id: "w1" };
const rexProcess = (argv0: string, cwd: string) => JSON.stringify({ last_exit: null, foreground: { pid: 1, name: argv0.split("/").at(-1), argv0, cwd } });
const listing = [
	"@@herdr default",
	JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running", message: "no herdr server is running" } }),
	"@@herdr work",
	JSON.stringify({ id: "cli:agent:list", result: { agents: [herdrAgent], type: "agent_list" } }),
	"@@rex-sessions",
	JSON.stringify({ sessions: [{ session_id: "session:01a1867f-f531-7105-9a60-a5cfc874b7b2", label: "coder" }] }, null, 2),
	"@@rex-windows session:01a1867f-f531-7105-9a60-a5cfc874b7b2",
	JSON.stringify(
		{
			windows: [
				{ window_id: "window:01a1867f-f531-7105-9a60-a5cf33cad9e0", label: "pi-linux-lock", layers: [{ blocks: [{ block_id: "block:01a1867f-f531-718e-a0db-8ca1e7c834ae" }] }] },
				{ window_id: "window:01a1867f-f531-7105-9a60-a5cf8b7b20df", label: "Window 8b7b20df", layers: [{ blocks: [{ block_id: "block:01a1867f-f54b-76f1-b0b6-210949d15dc0" }] }] },
			],
		},
		null,
		2,
	),
	"@@rex session:01a1867f-f531-7105-9a60-a5cfc874b7b2 block:01a1867f-f531-718e-a0db-8ca1e7c834ae",
	rexProcess("/Users/me/.local/bin/claude", "/Users/me/pi-mobile"),
	JSON.stringify({ records: [{ state: "working", app: "claude-code", effective_app: "claude-code", msg: "Running the tests" }] }),
	JSON.stringify({ title: "Fix the widget" }),
	"@@rex session:01a1867f-f531-7105-9a60-a5cfc874b7b2 block:01a1867f-f54b-76f1-b0b6-210949d15dc0",
	rexProcess("pi", "/Users/me/inbox"),
	JSON.stringify({ records: [] }),
	JSON.stringify({ title: "π - inbox" }),
	"@@rex session:01a1867f-f531-7105-9a60-a5cfc874b7b2 block:01a1867f-f568-7e0d-bf8c-08179fcd29d9",
	rexProcess("-zsh", "/Users/me"),
	JSON.stringify({ records: [] }),
	JSON.stringify({ title: "zsh" }),
	"@@rex session:01a1867f-f531-7105-9a60-a5cfc874b7b2 block:01a1867f-f587-7343-bf34-55979ef34b37",
	"Error: block target not found",
	"Error: block target not found",
	"Error: block target not found",
].join("\n");

assert.deepEqual(workers(listing), [
	{ id: "herdr:work:w1:p1", name: "tester", agent: "claude", status: "needs_user", cwd: "/Users/me/app", title: "Claude Code", doing: "" },
	{ id: "rex:74b7b2:c834ae", name: "pi-linux-lock", agent: "claude-code", status: "working", cwd: "/Users/me/pi-mobile", title: "Fix the widget", doing: "Running the tests" },
	{ id: "rex:74b7b2:d15dc0", name: "coder", agent: "pi", status: "unknown", cwd: "/Users/me/inbox", title: "π - inbox", doing: "" },
]);
assert.deepEqual(workers(""), []);

const paired = (address: string): PairedHost => ({ id: address, name: address, address, os: "darwin", arch: "arm64", user: "me", home: "/Users/me", key: "k" });
const mini = paired("geminixiangmac-mini.tail1.ts.net");
const air = paired("geminixiangmacbook-air.tail1.ts.net");
const reach = (id: string, own: PairedHost | undefined) => {
	const reached = reachAgent(id, [mini, air], own, (host) => new HostCommands(host));
	return reached.ok ? { id: reached.id, host: reached.host.address, place: reached.place } : reached.reason;
};
assert.deepEqual(parseAgentId("geminixiangmac-mini/rex:f3fea1:5d91e3"), { form: "on_computer", computer: "geminixiangmac-mini", local: "rex:f3fea1:5d91e3" });
assert.deepEqual(parseAgentId("rex:f3fea1:5d91e3"), { form: "legacy_on_own_computer", local: "rex:f3fea1:5d91e3" });
assert.deepEqual(parseAgentId("hc:office/t7"), { form: "legacy_on_own_computer", local: "hc:office/t7" }, "a slash inside an hc terminal is not a computer");
assert.deepEqual(parseAgentId("air/hc:office/t7"), { form: "on_computer", computer: "air", local: "hc:office/t7" });
assert.deepEqual(reach("geminixiangmacbook-air/rex:f3fea1:5d91e3", mini), { id: "geminixiangmacbook-air/rex:f3fea1:5d91e3", host: air.address, place: { via: "rex", session: "f3fea1", block: "5d91e3" } });
assert.deepEqual(reach("rex:f3fea1:5d91e3", mini), { id: "geminixiangmac-mini/rex:f3fea1:5d91e3", host: mini.address, place: { via: "rex", session: "f3fea1", block: "5d91e3" } }, "a stored watch without a computer still means the bot's own");
assert.equal(reach("rex:f3fea1:5d91e3", undefined), "phone");
assert.equal(reach("office-pc/rex:f3fea1:5d91e3", mini), "not_paired");
assert.equal(reach("geminixiangmac-mini/w1:p1", mini), "not_an_id");

assert.deepEqual(placeOf("herdr:default:w1:p1"), { via: "herdr", session: "default", pane: "w1:p1" });
assert.deepEqual(placeOf("rex:74b7b2:c834ae"), { via: "rex", session: "74b7b2", block: "c834ae" });
assert.equal(placeOf("rex:c834ae"), undefined);
assert.equal(placeOf("rex:"), undefined);
assert.equal(placeOf("herdr:default"), undefined);
assert.equal(placeOf("w1:p1"), undefined);

const herdr = { via: "herdr", session: "default", pane: "w1:p1" } as const;
const rex = { via: "rex", session: "74b7b2", block: "c834ae" } as const;
assert.deepEqual(reading(herdr, `${JSON.stringify({ result: { agent: { ...herdrAgent, agent_status: "done" } } })}\n@@screen\n⏺ 0 files.\n❯`), { ok: true, status: "idle", doing: "", screen: "⏺ 0 files.\n❯", stopped: false });
assert.deepEqual(reading(herdr, `${JSON.stringify({ error: { code: "agent_not_found", message: "no agent w1:p9" } })}\n@@screen\n`), { ok: false, problem: "agent_not_found: no agent w1:p9" });
assert.deepEqual(reading(rex, `${JSON.stringify({ records: [{ state: "blocked", app: "claude-code" }] })}\n@@screen\nDo you want to proceed?`), { ok: true, status: "needs_user", doing: "", screen: "Do you want to proceed?", stopped: false });
assert.deepEqual(reading(rex, "Error: block target \"c834ae\" not found\n@@screen\nError"), { ok: false, problem: 'Error: block target "c834ae" not found' });
assert.deepEqual(reading(rex, "zsh: command not found: rex"), { ok: false, problem: "zsh: command not found: rex" });

assert.equal(sendProblem(herdr, JSON.stringify({ result: { agent: herdrAgent } })), undefined);
assert.equal(sendProblem(herdr, JSON.stringify({ error: { code: "agent_blocked", message: "agent tester is blocked" } })), "agent_blocked: agent tester is blocked");
assert.equal(sendProblem(rex, ""), undefined);


if (existsSync("/bin/zsh")) {
	const home = mkdtempSync(join(tmpdir(), "agents-"));
	mkdirSync(join(home, ".local/bin"), { recursive: true });
	writeFileSync(join(home, ".local/bin/herdr"), `#!/bin/sh\necho '${JSON.stringify({ result: { agents: [herdrAgent], type: "agent_list" } })}'\n`, { mode: 0o755 });
	const listed = spawnSync("/bin/zsh", ["-lc", LIST], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
	rmSync(home, { recursive: true });
	assert.equal(listed.status, 0, listed.stderr);
	assert.deepEqual(workers(listed.stdout).map((worker) => worker.id), ["herdr:default:w1:p1"]);
}

if (existsSync("/bin/zsh")) {
	const home = mkdtempSync(join(tmpdir(), "jobs-"));
	const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
	const job = (id: string, files: Record<string, string>, at = new Date()) => {
		const dir = join(home, ".pi-mobile/jobs", id);
		mkdirSync(dir, { recursive: true });
		for (const [name, content] of Object.entries({ command: `make ${id}\n`, cwd: `${home}\n`, ...files })) {
			writeFileSync(join(dir, name), content);
			utimesSync(join(dir, name), at, at);
		}
	};
	job("aaaaaaa1", { pid: `${process.pid}\n` }, hoursAgo(3));
	job("aaaaaaa2", { pid: "1\n", exit: "0\n" }, hoursAgo(0.5));
	job("aaaaaaa3", { pid: "1\n", exit: "0\n" }, hoursAgo(2));
	job("aaaaaaa4", { pid: "none\n", log: "built\n" }, hoursAgo(2));
	job("aaaaaaa5", { pid: "none\n", log: "built\n" }, hoursAgo(0.2));
	const listed = spawnSync("/bin/zsh", ["-lc", LIST], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
	rmSync(home, { recursive: true });
	assert.deepEqual(
		workers(listed.stdout).map((worker) => [worker.id, worker.status, worker.doing]).toSorted(),
		[["job:aaaaaaa1", "working", "running"], ["job:aaaaaaa2", "idle", "exited 0"], ["job:aaaaaaa5", "idle", "lost"]],
		"a background command is listed while it runs and for an hour after it ends, not for the day it is kept",
	);
}

assert.deepEqual(placeOf("job:1a2b3c4d"), { via: "job", id: "1a2b3c4d" });
assert.equal(placeOf("job:../../etc"), undefined, "a job id is only what bash makes, so it cannot reach outside the jobs folder");
const job = { via: "job" as const, id: "1a2b3c4d" };
assert.deepEqual(reading(job, "state=running\nseconds=1\nlines=1\nbytes=9\nlog=/l\n@@log\nbuilding\n@@screen\n"), { ok: true, status: "working", doing: "running", screen: "building", stopped: false });
assert.deepEqual(reading(job, "state=stopped\nexit=143\nlines=1\nbytes=9\nlog=/l\n@@log\nbuilding\n@@screen\n"), { ok: true, status: "idle", doing: "stopped by the user", screen: "building", stopped: true }, "a job the user stopped says so");
assert.deepEqual(reading(job, "state=missing"), { ok: false, problem: "no background command 1a2b3c4d" });

if (existsSync("/bin/zsh")) {
	const home = mkdtempSync(join(tmpdir(), "jobs-"));
	const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
	const zsh = (script: string) => spawnSync("/bin/zsh", ["-lc", script], { env, encoding: "utf8" });
	const started = zsh(startJob({ id: "0badc0de", command: "sleep 1\necho built; exit 4", cwd: home, owner: "bot", limitSeconds: 60 }));
	assert.equal(started.status, 0, started.stderr);
	assert.deepEqual(workers(zsh(LIST).stdout).map((worker) => [worker.id, worker.status, worker.title]), [["job:0badc0de", "working", "sleep 1"]], "the start returns while the command still runs");
	const place = { via: "job" as const, id: "0badc0de" };
	const deadline = Date.now() + 10_000;
	const read = () => reading(place, zsh(readCommand(place, 5)).stdout);
	const working = () => {
		const state = read();
		return state.ok && state.status === "working";
	};
	while (Date.now() < deadline && working()) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(read(), { ok: true, status: "idle", doing: "exited 4", screen: "built", stopped: false });
		rmSync(home, { recursive: true });
}

const approval = [
	" │ git worktree list && git worktree add -b fix-widget-delete /Users/me/pi-mobile-fix",
	"╌╌╌╌╌╌╌╌╌╌╌╌",
	" This command requires approval",
	" Do you want to proceed?",
	" ❯ 1. Yes",
	"   2. Yes, and don’t ask again",
	"      for: git worktree *",
	"   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
	"   4. No",
	" Esc to cancel · Tab to amend",
].join("\n");
assert.deepEqual(choicesOf(approval), { options: ["Yes", "Yes, and don’t ask again for: git worktree *", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"], at: 0 });
const trust = [" Claude Code'll be able to read, edit, and execute files here.", "", " Security guide", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"].join("\n");
assert.deepEqual(choicesOf(trust), { options: ["No, exit", "Yes, I trust this folder"], at: 0 });
assert.deepEqual(choicesOf(" Do you want to proceed?\n   1. Yes\n ❯ 2. No"), { options: ["Yes", "No"], at: 1 });
assert.equal(choicesOf("────────\n❯ \n────────\n  ⏵⏵ auto mode on"), undefined);
assert.equal(choicesOf("⏺ 0 files.\n❯ commit 吧"), undefined);

const hcList = {
	terminals: [
		{ address: "t3", agent: "pwsh.exe", cwd: "C:\\Users\\me", state: "live", turn: 5 },
		{ address: "t5", agent: "C:\\tools\\Claude.exe", cwd: "C:/work/app", state: "live", status: "blocked", name: "fixer", title: "Claude Code" },
		{ address: "t6", agent: "codex", cwd: "C:/work", state: "finished" },
	],
};
assert.deepEqual(workers(`@@hc\n${JSON.stringify(hcList)}`), [
	{ id: "hc:t5", name: "fixer", agent: "claude", status: "needs_user", cwd: "C:/work/app", title: "Claude Code", doing: "" },
	{ id: "hc:t6", name: "", agent: "codex", status: "idle", cwd: "C:/work", title: "", doing: "" },
], "Herdr on Windows (hc) lists its coding agents, not its shells");
assert.deepEqual(workers(`@@hc\n${JSON.stringify({ error: { kind: "unavailable", message: "the Windows core is not reachable" } })}`), [], "an hc that is not running lists nothing");
assert.deepEqual(placeOf("hc:t5"), { via: "hc", terminal: "t5" });
assert.deepEqual(placeOf("hc:office/t7"), { via: "hc", terminal: "office/t7" });
const hc = { via: "hc", terminal: "t5" } as const;
assert.deepEqual(reading(hc, `${JSON.stringify({ address: "t5", state: "live", status: { app: "pi", state: "working" } })}\n@@screen\n⏺ editing`), { ok: true, status: "working", doing: "", screen: "⏺ editing", stopped: false }, "hc get reports status as an object, hc ls as a string");
assert.deepEqual(reading(hc, `${JSON.stringify({ error: { kind: "not_found", message: "no terminal t5", hint: "hc ls" } })}\n@@screen\n`), { ok: false, problem: "no terminal t5 (hc ls)" });
assert.match(readCommand(hc, 40), /"\$hc" read 't5' --lines 40/);
assert.match(sendCommand(hc, "fix it"), /"\$hc" send 't5' 'fix it'/);
assert.match(keysCommand(hc, ["esc", "enter"]), /"\$hc" keys 't5' 'esc' 'enter'/);
assert.equal(sendProblem(hc, JSON.stringify({ error: { kind: "blocked", message: "the program is waiting" } })), "the program is waiting");

console.log("computer agents: Herdr's (also hc on Windows) and Rex's agents are listed with one status each, a shell or a gone block is not an agent, and ids lead back to their pane or block on the computer they name (an id without one means the bot's own), each carries the name the user calls it by (a Rex window's own label before its session's), the listing runs in zsh with no Herdr session, and a waiting agent's options are read from its screen; a background command starts at once, is listed while it runs and for an hour after, and is read with its exit code and output when it ends");
