import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIST, placeOf, reading, sendProblem, workers } from "../src/computer-agents/workers.ts";

const herdrAgent = { agent: "claude", agent_status: "blocked", cwd: "/Users/me/app", focused: true, name: "tester", pane_id: "w1:p1", terminal_title_stripped: "Claude Code", workspace_id: "w1" };
const rexProcess = (argv0: string, cwd: string) => JSON.stringify({ last_exit: null, foreground: { pid: 1, name: argv0.split("/").at(-1), argv0, cwd } });
const listing = [
	"@@herdr default",
	JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running", message: "no herdr server is running" } }),
	"@@herdr work",
	JSON.stringify({ id: "cli:agent:list", result: { agents: [herdrAgent], type: "agent_list" } }),
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
	{ id: "herdr:work:w1:p1", agent: "claude", status: "needs_user", cwd: "/Users/me/app", title: "Claude Code", doing: "" },
	{ id: "rex:74b7b2:c834ae", agent: "claude-code", status: "working", cwd: "/Users/me/pi-mobile", title: "Fix the widget", doing: "Running the tests" },
	{ id: "rex:74b7b2:d15dc0", agent: "pi", status: "unknown", cwd: "/Users/me/inbox", title: "π - inbox", doing: "" },
]);
assert.deepEqual(workers(""), []);

assert.deepEqual(placeOf("herdr:default:w1:p1"), { via: "herdr", session: "default", pane: "w1:p1" });
assert.deepEqual(placeOf("rex:74b7b2:c834ae"), { via: "rex", session: "74b7b2", block: "c834ae" });
assert.equal(placeOf("rex:c834ae"), undefined);
assert.equal(placeOf("rex:"), undefined);
assert.equal(placeOf("herdr:default"), undefined);
assert.equal(placeOf("w1:p1"), undefined);

const herdr = { via: "herdr", session: "default", pane: "w1:p1" } as const;
const rex = { via: "rex", session: "74b7b2", block: "c834ae" } as const;
assert.deepEqual(reading(herdr, `${JSON.stringify({ result: { agent: { ...herdrAgent, agent_status: "done" } } })}\n@@screen\n⏺ 0 files.\n❯`), { ok: true, status: "idle", doing: "", screen: "⏺ 0 files.\n❯" });
assert.deepEqual(reading(herdr, `${JSON.stringify({ error: { code: "agent_not_found", message: "no agent w1:p9" } })}\n@@screen\n`), { ok: false, problem: "agent_not_found: no agent w1:p9" });
assert.deepEqual(reading(rex, `${JSON.stringify({ records: [{ state: "blocked", app: "claude-code" }] })}\n@@screen\nDo you want to proceed?`), { ok: true, status: "needs_user", doing: "", screen: "Do you want to proceed?" });
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

console.log("computer agents: Herdr's and Rex's agents are listed with one status each, a shell or a gone block is not an agent, and ids lead back to their pane or block, and the listing runs in zsh with no Herdr session");
