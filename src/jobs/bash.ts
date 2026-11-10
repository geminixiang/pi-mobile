import type { Context } from "@earendil-works/chord";
import { type Static, Type } from "typebox";
import type { ConversationId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { HostCommands } from "../agent/sandbox/host.ts";
import type { Workplace } from "../agent/workplaces.ts";
import { watch } from "../triggers/watch.ts";
import type { TriggerHost } from "../triggers/tool.ts";
import { BACKGROUND, jobWatchName, WAIT_MS } from "./background.ts";
import { type Job, JOB_LIMIT_SECONDS, OUTPUT_BYTES, OUTPUT_LINES, parseJob, readJob, startJob, stopJob } from "./commands.ts";

const POLL_MS = 400;
const PROMPT_CHARS = 500;

export const BACKGROUND_NOTE = ` On a computer, a command still running after ${WAIT_MS / 1000} seconds goes on in the background for up to its timeout (default ${JOB_LIMIT_SECONDS / 3600} hours), and the phone wakes you when it ends.`;

export const JOB_BASH_PARAMETERS = Type.Object(
	{
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
		label: Type.Optional(Type.String({ description: "A few words in the user's language on what it does, such as 跑單元測試; shown while it runs in the background" })),
	},
	{ additionalProperties: true },
);

type Args = Static<typeof JOB_BASH_PARAMETERS>;
type Execute = (args: Args, api: ToolExecutionApi, context: Context) => Promise<ToolExecutionResult>;

export function jobsOnComputers(execute: Execute, workplace: (conversationId: string) => Workplace | undefined, triggers: TriggerHost, waitFor: (conversationId: ConversationId, job: string) => void): Execute {
	return async (args, api, context) => {
		const place = workplace(String(api.conversationId));
		if (place?.kind !== "computer" || !place.sandbox.direct) return execute(args, api, context);
		const commands = new HostCommands(place.host);
		const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
		const limitSeconds = args.timeout ?? JOB_LIMIT_SECONDS;
		const started = await commands.run(startJob({ id, command: args.command, cwd: api.env?.cwd ?? place.root, owner: String(api.conversationId), limitSeconds }));
		if (started.code !== 0) throw new Error(`The command did not start: ${started.stdout.trim() || started.stderr.trim() || "its folder is not on the computer"}`);
		const read = async () => parseJob((await commands.run(readJob(id))).stdout);
		const deadline = Date.now() + WAIT_MS;
		let job = await read();
		while (job.state === "running" && Date.now() < deadline) {
			if (context.abortSignal?.aborted) {
				await commands.run(stopJob(id));
				throw new Error("Command aborted");
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
			job = await read();
		}
		if (job.state === "missing") throw new Error("The command's record vanished from the computer");
		if (job.output.text) api.output(job.output.text);
		if (job.state !== "running") return ended(job, limitSeconds, api);
		const watched = await watch(triggers, api, context, {
			agent: `job:${id}`,
			name: jobWatchName(args.label?.trim() || args.command),
			prompt: `Your bash command ${JSON.stringify(args.command.slice(0, PROMPT_CHARS))} went on in the background as job:${id} and has now ended. Read how it ended with bash (tail -n 80 ${job.output.log}; the exit code is in ${job.output.log.slice(0, -"log".length)}exit), check the result, and tell the user the gist; they are waiting to hear.`,
		});
		if (watched) waitFor(api.conversationId, `job:${id}`);
		const after = watched
			? "Tell the user it is running, not that it is done: the phone wakes you here when it ends, so do not wait, poll, or schedule a follow-up for it."
			: `Check on it later with bash: tail ${job.output.log}.`;
		const note = `Still running after ${WAIT_MS / 1000} seconds, so it ${BACKGROUND}${id} (stopped after ${span(limitSeconds)} at most). ${after}`;
		return {
			output: [{ type: "text", text: [job.output.text.trimEnd(), note].filter(Boolean).join("\n\n") }],
			structuredOutput: { output: api.retainedOutput().text, truncated: api.retainedOutput().truncated, exitCode: -1, job: `job:${id}`, running: true },
		};
	};
}

function ended(job: Extract<Job, { exitCode: number | undefined }>, limitSeconds: number, api: ToolExecutionApi): ToolExecutionResult {
	const truncated = job.output.lines > OUTPUT_LINES || job.output.bytes > OUTPUT_BYTES;
	if (truncated) api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${job.output.log}` });
	if (job.state === "timed_out") throw new Error(`Command timed out after ${limitSeconds} seconds`);
	if (job.state === "stopped") throw new Error("Command stopped");
	if (job.state === "lost") throw new Error("The command ended without an exit code: something on the computer killed it");
	const retained = api.retainedOutput();
	const exitCode = job.exitCode ?? -1;
	const structuredOutput = { output: retained.text, truncated: retained.truncated || truncated, ...(truncated ? { fullOutputPath: job.output.log } : {}), exitCode };
	if (exitCode === 0) return { structuredOutput };
	return { structuredOutput, isError: true, diagnostics: [{ severity: "error", code: "exit_code", message: `Command exited with code ${exitCode}` }] };
}

function span(seconds: number): string {
	if (seconds < 120) return `${Math.round(seconds)} seconds`;
	if (seconds < 2 * 3600) return `${Math.round(seconds / 60)} minutes`;
	return `${Math.round(seconds / 3600)} hours`;
}
