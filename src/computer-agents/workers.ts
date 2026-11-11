import { Type } from "typebox";
import { checkJson } from "../parse.ts";
import { shellQuote } from "../agent/shell.ts";
import { JOB_ID, JOBS, type Job, parseJob, readJob } from "../jobs/commands.ts";

export type Status = "idle" | "working" | "needs_user" | "unknown";

export interface Worker {
	id: string;
	name: string;
	agent: string;
	status: Status;
	cwd: string;
	title: string;
	doing: string;
}

export type AgentPlace = { via: "herdr"; session: string; pane: string } | { via: "rex"; session: string; block: string } | { via: "hc"; terminal: string };

export type Place = AgentPlace | { via: "job"; id: string };

const FIND = [
	'herdr="$(command -v herdr || printf %s "$HOME/.local/bin/herdr")"',
	'rex="$(command -v rex || printf %s "$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex")"',
	'hc="$(command -v hc || printf %s "$LOCALAPPDATA/Programs/herdr-core/hc.exe")"',
].join("; ");
const HC = '"$hc"';
const HERDR = '"$herdr"';
const REX = '"$rex" --autostart=false';
const DAY_MINUTES = 1440;
const SECTION = "@@";
const SCREEN = "@@screen";
const SHORT = 6;
const AGENTS = new Set(["claude", "codex", "pi", "opencode", "gemini", "amp", "cursor-agent", "droid", "copilot"]);

export const LIST = [
	FIND,
	'if [ -x "$herdr" ]; then',
	`  echo "${SECTION}herdr default"; ${HERDR} agent list 2>&1`,
	'  find "$HOME/.config/herdr/sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r dir; do',
	'    [ -S "$dir/herdr.sock" ] || continue',
	`    name=$(basename "$dir"); echo "${SECTION}herdr $name"; ${HERDR} --session "$name" agent list 2>&1`,
	"  done",
	"fi",
	`if [ -x "$hc" ]; then echo "${SECTION}hc"; ${HC} ls --json 2>&1; fi`,
	'if [ -x "$rex" ]; then',
	`  echo "${SECTION}rex-sessions"; ${REX} ls --json 2>&1`,
	`  for session in $(${REX} ls -q 2>/dev/null); do`,
	`    for block in $(${REX} block ls -s "$session" -q 2>/dev/null); do`,
	`      echo "${SECTION}rex $session $block"`,
	`      ${REX} block call -s "$session" --block "$block" process 2>&1`,
	`      ${REX} block call -s "$session" --block "$block" program_status 2>&1`,
	`      ${REX} block call -s "$session" --block "$block" title 2>&1`,
	"    done",
	"  done",
	"fi",
	`find ${JOBS} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r dir; do`,
	'  [ -f "$dir/command" ] || continue',
	`  if [ -n "$(find "$dir/exit" -mmin +${DAY_MINUTES} 2>/dev/null)" ]; then rm -rf "$dir"; continue; fi`,
	`  echo "${SECTION}job $(basename "$dir")"; head -n 1 "$dir/command"; head -n 1 "$dir/cwd"`,
	'  if [ -f "$dir/exit" ]; then echo "$(cat "$dir/reason" 2>/dev/null || echo exited) $(cat "$dir/exit")"; elif kill -0 "$(cat "$dir/pid" 2>/dev/null)" 2>/dev/null; then echo; else echo "$(cat "$dir/reason" 2>/dev/null || echo lost)"; fi',
	"done",
].join("\n");

const HerdrAgent = Type.Object({
	agent: Type.String(),
	agent_status: Type.String(),
	cwd: Type.String(),
	pane_id: Type.String(),
	name: Type.Optional(Type.String()),
	terminal_title_stripped: Type.Optional(Type.String()),
});
const HerdrList = Type.Object({ result: Type.Object({ agents: Type.Array(HerdrAgent) }) });
const HerdrGet = Type.Object({ result: Type.Object({ agent: HerdrAgent }) });
const HerdrError = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }) });
const RexProcess = Type.Object({ foreground: Type.Union([Type.Null(), Type.Object({ argv0: Type.Optional(Type.String()), name: Type.String(), cwd: Type.Optional(Type.String()) })]) });
const RexStatus = Type.Object({ records: Type.Array(Type.Object({ state: Type.String(), app: Type.String(), msg: Type.Optional(Type.String()) })) });
const RexTitle = Type.Object({ title: Type.String() });
const RexSessions = Type.Object({ sessions: Type.Array(Type.Object({ session_id: Type.String(), label: Type.String() })) });
const HcTerminal = Type.Object({ address: Type.String(), agent: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), state: Type.String(), status: Type.Optional(Type.Union([Type.String(), Type.Object({ state: Type.String() }), Type.Null()])), name: Type.Optional(Type.Union([Type.String(), Type.Null()])), title: Type.Optional(Type.String()) });
const HcList = Type.Object({ terminals: Type.Array(HcTerminal) });
const HcError = Type.Object({ error: Type.Object({ kind: Type.String(), message: Type.String(), hint: Type.Optional(Type.String()) }) });

const STATUS: Record<string, Status> = { idle: "idle", done: "idle", failed: "idle", working: "working", blocked: "needs_user" };

export function workers(output: string): Worker[] {
	const sections = output
		.split(`\n${SECTION}`)
		.map((chunk) => (chunk.startsWith(SECTION) ? chunk.slice(SECTION.length) : chunk))
		.map((chunk) => {
			const [head = "", ...lines] = chunk.split("\n");
			const [via = "", name = "", block = ""] = head.split(" ");
			return { via, name, block, lines };
		});
	const listed = checkJson(RexSessions, sections.find((section) => section.via === "rex-sessions")?.lines.join("\n") ?? "", "rex ls");
	const labels = new Map(listed.ok ? listed.value.sessions.map((session) => [session.session_id, session.label]) : []);
	return sections.flatMap(({ via, name, block, lines }) => {
		if (via === "herdr") return herdrWorkers(name, lines[0] ?? "");
		if (via === "hc") return hcWorkers(lines.join("\n"));
		if (via === "rex") return rexWorker(name, labels.get(name) ?? "", block, lines);
		if (via === "job") return [jobWorker(name, lines)];
		return [];
	});
}

function herdrWorkers(session: string, line: string): Worker[] {
	const list = checkJson(HerdrList, line, "herdr agent list");
	if (!list.ok) return [];
	return list.value.result.agents.map((agent) => ({
		id: `herdr:${session}:${agent.pane_id}`,
		name: agent.name ?? "",
		agent: agent.agent,
		status: STATUS[agent.agent_status] ?? "unknown",
		cwd: agent.cwd,
		title: agent.terminal_title_stripped ?? "",
		doing: "",
	}));
}

function hcStatus(terminal: { state: string; status?: string | { state: string } | null }): Status {
	if (terminal.state !== "live") return "idle";
	const status = typeof terminal.status === "string" ? terminal.status : terminal.status?.state;
	return (status && STATUS[status]) || "unknown";
}

function programOf(agent: string): string {
	const file = (agent.split("\\").at(-1) ?? "").split("/").at(-1)?.toLowerCase() ?? "";
	return file.endsWith(".exe") ? file.slice(0, -".exe".length) : file;
}

function hcWorkers(json: string): Worker[] {
	const list = checkJson(HcList, json.trim(), "hc ls");
	if (!list.ok) return [];
	return list.value.terminals.flatMap((terminal) => {
		const agent = programOf(terminal.agent ?? "");
		if (!AGENTS.has(agent)) return [];
		return [{ id: `hc:${terminal.address}`, name: terminal.name ?? "", agent, status: hcStatus(terminal), cwd: terminal.cwd ?? "", title: terminal.title ?? "", doing: "" }];
	});
}

function rexWorker(session: string, label: string, block: string, [processLine = "", statusLine = "", titleLine = ""]: string[]): Worker[] {
	const process = checkJson(RexProcess, processLine, "rex process");
	const status = checkJson(RexStatus, statusLine, "rex program_status");
	const record = status.ok ? status.value.records[0] : undefined;
	const foreground = process.ok ? process.value.foreground : null;
	const program = foreground?.argv0?.split("/").at(-1) ?? foreground?.name ?? "";
	const agent = record?.app ?? (AGENTS.has(program) ? program : undefined);
	if (!agent) return [];
	const title = checkJson(RexTitle, titleLine, "rex title");
	return [
		{
			id: `rex:${session.slice(-SHORT)}:${block.slice(-SHORT)}`,
			name: label,
			agent,
			status: record ? (STATUS[record.state] ?? "unknown") : "unknown",
			cwd: foreground?.cwd ?? "",
			title: title.ok ? title.value.title : "",
			doing: record?.msg ?? "",
		},
	];
}

function jobWorker(id: string, [command = "", cwd = "", ended = ""]: string[]): Worker {
	const state = ended.trim() ? { status: "idle" as const, doing: ended.trim() } : { status: "working" as const, doing: "running" };
	return { id: `job:${id}`, name: "", agent: "command", ...state, cwd: cwd.trim(), title: command.trim() };
}

export function jobEnding(job: Exclude<Job, { state: "running" | "missing" }>): string {
	if (job.state === "timed_out") return "stopped at its time limit";
	if (job.state === "stopped") return "stopped by the user";
	if (job.state === "lost") return "gone without an exit code (the computer restarted or something killed it)";
	return `exited ${job.exitCode ?? "?"}`;
}

export function placeOf(id: string): Place | undefined {
	const [via, session, ...rest] = id.split(":");
	if (via === "job" && session && JOB_ID.test(session) && rest.length === 0) return { via, id: session };
	if (via === "hc" && session && rest.length <= 1) return { via, terminal: [session, ...rest].join(":") };
	if (!session || rest.length === 0) return undefined;
	if (via === "rex" && rest.length === 1 && rest[0]) return { via, session, block: rest[0] };
	if (via === "herdr") return { via, session, pane: rest.join(":") };
	return undefined;
}

const rexAt = (place: Extract<Place, { via: "rex" }>) => `-s ${shellQuote(place.session)} -b ${shellQuote(place.block)}`;

const herdr = (session: string) => (session === "default" ? HERDR : `${HERDR} --session ${shellQuote(session)}`);

export function readCommand(place: Place, lines: number): string {
	if (place.via === "job") return `${readJob(place.id, lines)}\necho ${SCREEN}`;
	if (place.via === "hc") return `${FIND}; ${HC} get ${shellQuote(place.terminal)} --json 2>&1; echo ${SCREEN}; ${HC} read ${shellQuote(place.terminal)} --lines ${lines} 2>&1`;
	if (place.via === "herdr") {
		const cli = herdr(place.session);
		return `${FIND}; ${cli} agent get ${shellQuote(place.pane)} 2>&1; echo ${SCREEN}; ${cli} agent read ${shellQuote(place.pane)} --source recent-unwrapped --lines ${lines} 2>&1`;
	}
	const at = rexAt(place);
	return `${FIND}; ${REX} block call ${at} program_status 2>&1; echo ${SCREEN}; ${REX} block capture ${at} --trim 2>&1 | tail -n ${lines}`;
}

export function sendCommand(place: AgentPlace, text: string): string {
	if (place.via === "hc") return `${FIND}; ${HC} send ${shellQuote(place.terminal)} ${shellQuote(text)} 2>&1`;
	if (place.via === "herdr") return `${FIND}; ${herdr(place.session)} agent prompt ${shellQuote(place.pane)} ${shellQuote(text)} 2>&1`;
	const at = rexAt(place);
	return `${FIND}; { printf '\\033[200~'; printf '%s' ${shellQuote(text)}; printf '\\033[201~'; } | ${REX} block send ${at} && sleep 0.3 && ${REX} block send-key ${at} enter`;
}

export type Reading = { ok: true; status: Status; doing: string; screen: string } | { ok: false; problem: string };

export function reading(place: Place, output: string): Reading {
	if (place.via === "job") {
		const end = output.lastIndexOf(SCREEN);
		const job = parseJob(end < 0 ? output : output.slice(0, end));
		if (job.state === "missing") return { ok: false, problem: `no background command ${place.id}` };
		return job.state === "running" ? { ok: true, status: "working", doing: "running", screen: job.output.text.trim() } : { ok: true, status: "idle", doing: jobEnding(job), screen: job.output.text.trim() };
	}
	const at = output.indexOf(SCREEN);
	if (at < 0) return { ok: false, problem: output.trim() };
	const head = output.slice(0, at).trim();
	const screen = output.slice(at + SCREEN.length).trim();
	if (place.via === "hc") {
		const got = checkJson(HcTerminal, head, "hc get");
		if (got.ok) return { ok: true, status: hcStatus(got.value), doing: "", screen };
		const failed = checkJson(HcError, head, "hc error");
		return { ok: false, problem: failed.ok ? `${failed.value.error.message}${failed.value.error.hint ? ` (${failed.value.error.hint})` : ""}` : head };
	}
	if (place.via === "herdr") {
		const got = checkJson(HerdrGet, head, "herdr agent get");
		if (got.ok) return { ok: true, status: STATUS[got.value.result.agent.agent_status] ?? "unknown", doing: "", screen };
		const failed = checkJson(HerdrError, head, "herdr error");
		return { ok: false, problem: failed.ok ? `${failed.value.error.code}: ${failed.value.error.message}` : head };
	}
	const status = checkJson(RexStatus, head, "rex program_status");
	if (!status.ok) return { ok: false, problem: head };
	const record = status.value.records[0];
	return { ok: true, status: record ? (STATUS[record.state] ?? "unknown") : "unknown", doing: record?.msg ?? "", screen };
}

export function sendProblem(place: AgentPlace, output: string): string | undefined {
	if (place.via === "rex") return output.trim() === "" ? undefined : output.trim();
	if (place.via === "hc") {
		const failed = checkJson(HcError, output.trim(), "hc error");
		return failed.ok ? failed.value.error.message : undefined;
	}
	const failed = checkJson(HerdrError, output.trim(), "herdr error");
	return failed.ok ? `${failed.value.error.code}: ${failed.value.error.message}` : undefined;
}

const CURSOR = "❯ ";
const NUMBERED = /^\d+\.\s+/;

export type Choices = { options: string[]; at: number };

export function choicesOf(screen: string): Choices | undefined {
	const lines = screen.split("\n");
	const marker = lines.findLastIndex((line) => line.trimStart().startsWith(CURSOR) && line.trim().length > CURSOR.length);
	if (marker < 0) return undefined;
	const column = (lines[marker] ?? "").indexOf(CURSOR) + CURSOR.length;
	const starts = (line: string) => line.length > column && line.slice(0, column).replace(CURSOR, "").trim() === "" && line[column] !== " ";
	const deeper = (line: string) => line.slice(0, column + 1).trim() === "" && line.trim() !== "";
	let first = marker;
	while (first > 0 && (starts(lines[first - 1] ?? "") || deeper(lines[first - 1] ?? ""))) first--;
	while (first < marker && !starts(lines[first] ?? "")) first++;
	const options: string[] = [];
	let at = 0;
	for (let index = first; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (starts(line)) {
			if (index === marker) at = options.length;
			options.push(line.slice(column).trim().replace(NUMBERED, ""));
		} else if (deeper(line) && options.length > 0) options[options.length - 1] += ` ${line.trim()}`;
		else break;
	}
	return options.length > 1 ? { options, at } : undefined;
}

export function keysCommand(place: AgentPlace, keys: readonly string[]): string {
	const words = keys.map(shellQuote).join(" ");
	if (place.via === "hc") return `${FIND}; ${HC} keys ${shellQuote(place.terminal)} ${words} 2>&1`;
	if (place.via === "herdr") return `${FIND}; ${herdr(place.session)} agent send-keys ${shellQuote(place.pane)} ${words} 2>&1`;
	return `${FIND}; ${REX} block send-key ${rexAt(place)} ${words} 2>&1`;
}
