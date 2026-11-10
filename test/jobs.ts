import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Job, parseJob, readJob, startJob, stopJob, stopOwnedJobs, waitJob } from "../src/jobs/commands.ts";
import { backgroundJobIn } from "../src/jobs/background.ts";

assert.deepEqual(parseJob("state=running\nseconds=3\nlines=  2\nbytes=  10\nlog=/h/.pi-mobile/jobs/0badc0de/log\n@@log\na\nb\n"), {
	state: "running",
	seconds: 3,
	output: { text: "a\nb\n", lines: 2, bytes: 10, log: "/h/.pi-mobile/jobs/0badc0de/log" },
});
assert.deepEqual(parseJob("state=timed_out\nexit=\nseconds=7\nlines=0\nbytes=0\nlog=/l\n@@log\n").state, "timed_out");
assert.deepEqual(parseJob("state=missing"), { state: "missing" });
assert.equal(backgroundJobIn("built\n\nStill running after 10 seconds, so it goes on in the background as job:0badc0de (stopped after 120 minutes at most)."), "job:0badc0de");
assert.equal(backgroundJobIn("exit 0"), undefined);

if (existsSync("/bin/zsh")) {
	const home = mkdtempSync(join(tmpdir(), "jobs-"));
	const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
	const zsh = (script: string) => spawnSync("/bin/zsh", ["-lc", script], { env, encoding: "utf8" });
	const start = (id: string, command: string, more: { owner?: string; limitSeconds?: number } = {}) => {
		const started = zsh(startJob({ id, command, cwd: home, owner: more.owner ?? "bot", limitSeconds: more.limitSeconds ?? 60 }));
		assert.equal(started.status, 0, started.stderr);
	};
	const read = (id: string): Job => parseJob(zsh(readJob(id)).stdout);
	const settle = async (id: string, seconds: number) => {
		const deadline = Date.now() + seconds * 1000;
		while (Date.now() < deadline && read(id).state === "running") await new Promise((resolve) => setTimeout(resolve, 200));
		return read(id);
	};
	const alive = (marker: string) => spawnSync("/bin/sh", ["-c", `ps -A -o command | grep -v grep | grep -c '${marker}'`], { encoding: "utf8" }).stdout.trim() !== "0";

	const waitFor = (id: string) => {
		const began = Date.now();
		const waited = spawnSync("/bin/zsh", ["-lc", waitJob(id)], { env, encoding: "utf8" });
		return { code: waited.status, seconds: (Date.now() - began) / 1000 };
	};

	start("0badc0de", "sleep 1\necho built; exit 4");
	assert.equal(read("0badc0de").state, "running", "the start returns while the command still runs");
	const built = await settle("0badc0de", 10);
	assert.ok(built.state === "exited", built.state);
	assert.equal(built.exitCode, 4);
	assert.equal(built.output.text, "built\n");

	start("8badc0de", "sleep 2");
	const waited = waitFor("8badc0de");
	assert.equal(waited.code, 0);
	assert.ok(waited.seconds > 1 && waited.seconds < 5, `the wait returns when the job ends, not later: ${waited.seconds}s`);
	assert.equal(read("8badc0de").state, "exited");
	assert.equal(waitFor("9badc0de").code, 4, "waiting for a job that is not there says so at once");

	start("1badc0de", "sleep 31.25 & sleep 31.25; echo never", { limitSeconds: 2 });
	const timedOut = await settle("1badc0de", 15);
	assert.equal(timedOut.state, "timed_out", "a job past its limit ends");
	assert.equal(alive("sleep 31.25"), false, "with the children it started");

	start("2badc0de", "sleep 32.25 & sleep 32.25");
	assert.equal(zsh(stopJob("2badc0de")).status, 0);
	assert.equal((await settle("2badc0de", 10)).state, "stopped", "a stopped job says so");
	assert.equal(alive("sleep 32.25"), false, "and its children are gone");

	start("3badc0de", "sleep 33.25", { owner: "bot-a" });
	start("4badc0de", "sleep 34.25", { owner: "bot-b" });
	assert.equal(zsh(stopOwnedJobs("bot-a")).status, 0);
	assert.equal((await settle("3badc0de", 10)).state, "stopped", "removing a bot stops its jobs");
	assert.equal(read("4badc0de").state, "running", "and only its jobs");
	zsh(stopJob("4badc0de"));

	start("5badc0de", "sleep 35.25");
	zsh(`kill -KILL -$(cat "$HOME/.pi-mobile/jobs/5badc0de/pid")`);
	assert.equal((await settle("5badc0de", 5)).state, "lost", "a job killed with its runner is lost, not running forever");

	assert.equal(zsh(startJob({ id: "6badc0de", command: "true", cwd: join(home, "missing"), owner: "bot", limitSeconds: 60 })).status, 3, "a folder that is not there does not start");
	assert.equal(read("7badc0de").state, "missing");
	rmSync(home, { recursive: true });
}

console.log("jobs: a background command reports its exit code and output, a wait on it returns as soon as it ends, ends with its children at its time limit or when stopped, stops with the bot that owns it, and is lost rather than running forever when killed with its runner; bash names the job it sent to the background");
