import { Type } from "typebox";
import { checkJson } from "../agent/parse.ts";
import { shellQuote } from "../agent/shell.ts";

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

export type Place = { via: "herdr"; session: string; pane: string } | { via: "rex"; session: string; block: string };

const FIND = [
	'herdr="$(command -v herdr || printf %s "$HOME/.local/bin/herdr")"',
	'rex="$(command -v rex || printf %s "$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex")"',
].join("; ");
const HERDR = '"$herdr"';
const REX = '"$rex" --autostart=false';
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

const HERDR_STATUS: Record<string, Status> = { idle: "idle", done: "idle", working: "working", blocked: "needs_user" };
const REX_STATUS: Record<string, Status> = { idle: "idle", done: "idle", failed: "idle", working: "working", blocked: "needs_user" };

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
		if (via === "rex") return rexWorker(name, labels.get(name) ?? "", block, lines);
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
		status: HERDR_STATUS[agent.agent_status] ?? "unknown",
		cwd: agent.cwd,
		title: agent.terminal_title_stripped ?? "",
		doing: "",
	}));
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
			status: record ? (REX_STATUS[record.state] ?? "unknown") : "unknown",
			cwd: foreground?.cwd ?? "",
			title: title.ok ? title.value.title : "",
			doing: record?.msg ?? "",
		},
	];
}

export function placeOf(id: string): Place | undefined {
	const [via, session, ...rest] = id.split(":");
	if (!session || rest.length === 0) return undefined;
	if (via === "rex" && rest.length === 1 && rest[0]) return { via, session, block: rest[0] };
	if (via === "herdr") return { via, session, pane: rest.join(":") };
	return undefined;
}

const herdr = (session: string) => (session === "default" ? HERDR : `${HERDR} --session ${shellQuote(session)}`);

export function readCommand(place: Place, lines: number): string {
	if (place.via === "herdr") {
		const cli = herdr(place.session);
		return `${FIND}; ${cli} agent get ${shellQuote(place.pane)} 2>&1; echo ${SCREEN}; ${cli} agent read ${shellQuote(place.pane)} --source recent-unwrapped --lines ${lines} 2>&1`;
	}
	const at = `-s ${shellQuote(place.session)} -b ${shellQuote(place.block)}`;
	return `${FIND}; ${REX} block call ${at} program_status 2>&1; echo ${SCREEN}; ${REX} block capture ${at} --trim 2>&1 | tail -n ${lines}`;
}

export function sendCommand(place: Place, text: string): string {
	if (place.via === "herdr") return `${FIND}; ${herdr(place.session)} agent prompt ${shellQuote(place.pane)} ${shellQuote(text)} 2>&1`;
	const at = `-s ${shellQuote(place.session)} -b ${shellQuote(place.block)}`;
	return `${FIND}; { printf '\\033[200~'; printf '%s' ${shellQuote(text)}; printf '\\033[201~'; } | ${REX} block send ${at} && sleep 0.3 && ${REX} block send-key ${at} enter`;
}

export type Reading = { ok: true; status: Status; doing: string; screen: string } | { ok: false; problem: string };

export function reading(place: Place, output: string): Reading {
	const at = output.indexOf(SCREEN);
	if (at < 0) return { ok: false, problem: output.trim() };
	const head = output.slice(0, at).trim();
	const screen = output.slice(at + SCREEN.length).trim();
	if (place.via === "herdr") {
		const got = checkJson(HerdrGet, head, "herdr agent get");
		if (got.ok) return { ok: true, status: HERDR_STATUS[got.value.result.agent.agent_status] ?? "unknown", doing: "", screen };
		const failed = checkJson(HerdrError, head, "herdr error");
		return { ok: false, problem: failed.ok ? `${failed.value.error.code}: ${failed.value.error.message}` : head };
	}
	const status = checkJson(RexStatus, head, "rex program_status");
	if (!status.ok) return { ok: false, problem: head };
	const record = status.value.records[0];
	return { ok: true, status: record ? (REX_STATUS[record.state] ?? "unknown") : "unknown", doing: record?.msg ?? "", screen };
}

export function sendProblem(place: Place, output: string): string | undefined {
	if (place.via === "rex") return output.trim() === "" ? undefined : output.trim();
	const failed = checkJson(HerdrError, output.trim(), "herdr error");
	return failed.ok ? `${failed.value.error.code}: ${failed.value.error.message}` : undefined;
}
