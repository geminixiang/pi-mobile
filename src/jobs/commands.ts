import { shellQuote } from "../agent/shell.ts";

export const JOBS = '"$HOME/.pi-mobile/jobs"';
export const JOB_ID = /^[0-9a-f]{8}$/;
export const JOB_LIMIT_SECONDS = 2 * 60 * 60;
export const OUTPUT_LINES = 2000;
export const OUTPUT_BYTES = 50 * 1024;
const LOG = "@@log";
const COMMAND = "@@command";

export type JobEnd = "exited" | "timed_out" | "stopped" | "lost";
export type Job = { state: "running"; seconds: number; output: Output } | { state: JobEnd; exitCode: number | undefined; seconds: number; output: Output } | { state: "missing" };
export type Output = { text: string; lines: number; bytes: number; log: string; command: string };

const dir = (id: string) => `${JOBS}/${id}`;

const RUN = [
	'cd "$(cat "$1/cwd")" || exit 3',
	"trap true TERM",
	'"${SHELL:-/bin/sh}" -l "$1/command" > "$1/log" 2>&1 &',
	"child=$!",
	"(",
	"  trap true TERM",
	'  end=$(( $(date +%s) + $(cat "$1/limit") ))',
	'  while kill -0 "$child" 2>/dev/null; do',
	'    if [ "$(date +%s)" -ge "$end" ]; then echo timed_out > "$1/reason"; kill -TERM -$$; sleep 5; kill -KILL -$$; fi',
	"    sleep 2",
	"  done",
	") &",
	'wait "$child"; code=$?',
	'while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done',
	'echo "$code" > "$1/exit.tmp" && mv "$1/exit.tmp" "$1/exit"',
].join("\n");

export function startJob(job: { id: string; command: string; cwd: string; owner: string; limitSeconds: number }): string {
	const at = dir(job.id);
	return [
		`mkdir -p ${at} && cd ${shellQuote(job.cwd)} || exit 3`,
		`printf '%s\\n' ${shellQuote(job.command)} > ${at}/command && pwd > ${at}/cwd`,
		`printf '%s\\n' ${shellQuote(job.owner)} > ${at}/owner && echo ${Math.max(1, Math.round(job.limitSeconds))} > ${at}/limit && date +%s > ${at}/started`,
		`printf '%s\\n' ${shellQuote(RUN)} > ${at}/run`,
		`sh -c 'set -m; nohup sh "$0/run" "$0" > /dev/null 2>&1 & echo $! > "$0/pid"' ${at}`,
	].join("\n");
}

export function readJob(id: string, lines = OUTPUT_LINES): string {
	const at = dir(id);
	return [
		`d=${at}`,
		'[ -d "$d" ] || { echo state=missing; exit 0; }',
		'if [ -f "$d/exit" ]; then echo "state=$(cat "$d/reason" 2>/dev/null || echo exited)"; echo "exit=$(cat "$d/exit")";',
		'elif kill -0 "$(cat "$d/pid" 2>/dev/null)" 2>/dev/null; then echo state=running;',
		'else echo "state=$(cat "$d/reason" 2>/dev/null || echo lost)"; fi',
		'echo "seconds=$(( $(date +%s) - $(cat "$d/started" 2>/dev/null || date +%s) ))"',
		'echo "lines=$(wc -l < "$d/log" 2>/dev/null || echo 0)"',
		'echo "bytes=$(wc -c < "$d/log" 2>/dev/null || echo 0)"',
		'echo "log=$(cd "$d" && pwd)/log"',
		`echo ${COMMAND}`,
		'cat "$d/command" 2>/dev/null',
		`echo ${LOG}`,
		`tail -n ${lines} "$d/log" 2>/dev/null | tail -c ${OUTPUT_BYTES}`,
	].join("\n");
}

const STOP_GROUP = [
	'pgid=$(cat "$d/pid" 2>/dev/null) || exit 0',
	'[ -f "$d/exit" ] && exit 0',
	'[ -f "$d/reason" ] || echo stopped > "$d/reason"',
	'kill -TERM -"$pgid" 2>/dev/null',
	'for i in 1 2 3 4 5; do kill -0 -"$pgid" 2>/dev/null || exit 0; sleep 1; done',
	'kill -KILL -"$pgid" 2>/dev/null',
].join("; ");

export function waitJob(id: string): string {
	return `d=${dir(id)}; [ -d "$d" ] || exit 4; while [ ! -f "$d/exit" ] && kill -0 "$(cat "$d/pid" 2>/dev/null)" 2>/dev/null; do sleep 1; done`;
}

export function stopJob(id: string): string {
	return `d=${dir(id)}; [ -d "$d" ] || exit 0; ${STOP_GROUP}`;
}

export function stopOwnedJobs(owner: string): string {
	return `for d in ${JOBS}/*; do [ "$(cat "$d/owner" 2>/dev/null)" = ${shellQuote(owner)} ] || continue; ( ${STOP_GROUP} ); done; exit 0`;
}

export function parseJob(stdout: string): Job {
	const at = stdout.indexOf(`${LOG}\n`);
	const commandAt = stdout.indexOf(`${COMMAND}\n`);
	const head = stdout.slice(0, commandAt >= 0 ? commandAt : at >= 0 ? at : stdout.length);
	const command = commandAt >= 0 ? stdout.slice(commandAt + COMMAND.length + 1, at >= 0 ? at : stdout.length).trimEnd() : "";
	const fields = new Map(head.split("\n").flatMap((line) => (line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()] as const] : [])));
	const state = fields.get("state");
	const number = (name: string) => {
		const value = Number(fields.get(name));
		return Number.isFinite(value) ? value : 0;
	};
	const output: Output = { text: at < 0 ? "" : stdout.slice(at + LOG.length + 1), lines: number("lines"), bytes: number("bytes"), log: fields.get("log") ?? "", command };
	const seconds = number("seconds");
	if (state === "running") return { state, seconds, output };
	if (state === "exited" || state === "timed_out" || state === "stopped" || state === "lost") {
		const exit = fields.get("exit");
		return { state, exitCode: exit === undefined || exit === "" ? undefined : Number(exit), seconds, output };
	}
	return { state: "missing" };
}
