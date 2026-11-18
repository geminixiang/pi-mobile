import type { ConversationId } from "@earendil-works/pi-durable";
import { type CommandClient, HostCommands } from "../computer/commands.ts";
import type { PairedHost } from "../computer/pairing.ts";
import type { Workplace } from "../agent/workplaces.ts";
import type { Trigger, TriggerRuns } from "../triggers/runs.ts";
import { orLogged } from "../promise.ts";
import { isJob, jobIdOf, watchShown } from "./background.ts";
import { JOB_ID, parseJob, readJob, stopJob, stopOwnedJobs, waitJob } from "./commands.ts";
import type { RunningJobs } from "./JobsContext.ts";

const PEEK_LINES = 60;

type Watches = Pick<TriggerRuns, "checkWatch" | "stopWatching" | "watching">;

type Computer = Pick<CommandClient, "run">;

export const computerOf = (place: Workplace | undefined): Computer | undefined => (place?.kind === "computer" ? new HostCommands(place.host) : undefined);

export class Jobs {
	readonly #waiting = new Set<string>();
	readonly #computer: (conversationId: string) => Computer | undefined;
	readonly #watches: Watches;

	constructor(computer: (conversationId: string) => Computer | undefined, watches: Watches) {
		this.#computer = computer;
		this.#watches = watches;
	}

	wait(id: ConversationId, job: string): void {
		const key = `${String(id)}\n${job}`;
		const on = this.#on(id, job);
		if (this.#waiting.has(key) || !on) return;
		this.#waiting.add(key);
		const waited = on.commands.run(waitJob(on.jobId)).then(async (ended) => {
			if (ended.code === 0) await this.#watches.checkWatch(id, job);
		});
		void orLogged(waited, "jobs.wait_failed", undefined, { job }).finally(() => this.#waiting.delete(key));
	}

	async resume(): Promise<void> {
		const watching = await orLogged(this.#watches.watching(), "jobs.resume_failed", []);
		for (const { conversationId, agent } of watching) if (isJob(agent)) this.wait(conversationId, agent);
	}

	of(id: ConversationId, triggers: readonly Trigger[]): RunningJobs {
		const jobs = triggers.flatMap((item) => (item.kind === "watch" && item.conversationId === id && isJob(item.agent) ? [{ job: item.agent, ...watchShown(item) }] : []));
		return { jobs, stop: (job) => this.stop(id, job), peek: (job) => this.#peek(id, job) };
	}

	async stop(id: ConversationId, job: string): Promise<void> {
		const on = this.#on(id, job);
		if (!on) return;
		const stopped = await on.commands.run(stopJob(on.jobId));
		if (stopped.code !== 0) throw new Error(stopped.stderr.trim() || `停不下來（exit ${stopped.code}）`);
		await this.#watches.stopWatching(id, job);
	}

	stopOwned(hosts: readonly PairedHost[], id: ConversationId, folder: string): Promise<unknown> {
		return Promise.all(hosts.map((host) => orLogged(new HostCommands(host).run(stopOwnedJobs(String(id))), "bot.stop_jobs_failed", undefined, { bot: folder, host: host.name })));
	}

	async #peek(id: ConversationId, job: string): Promise<{ command: string; output: string } | undefined> {
		const on = this.#on(id, job);
		if (!on) return undefined;
		const read = parseJob((await on.commands.run(readJob(on.jobId, PEEK_LINES))).stdout);
		return read.state === "missing" ? undefined : { command: read.output.command, output: read.output.text };
	}

	#on(id: ConversationId, job: string): { commands: Computer; jobId: string } | undefined {
		const commands = this.#computer(String(id));
		const jobId = jobIdOf(job) ?? "";
		return commands && JOB_ID.test(jobId) ? { commands, jobId } : undefined;
	}
}
