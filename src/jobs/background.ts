export const WAIT_MS = 10_000;
const JOB = "job:";
export const BACKGROUND = `goes on in the background as ${JOB}`;
export const jobAgent = (id: string) => `${JOB}${id}`;
export const isJob = (agent: string) => agent.startsWith(JOB);
export const jobIdOf = (agent: string) => (isJob(agent) ? agent.slice(JOB.length) : undefined);

export function watchShown(watch: { agent: string; name: string; createdAt: number }): { label: string; since: number } {
	return isJob(watch.agent) ? { label: jobCommand(watch.name), since: watch.createdAt - WAIT_MS } : { label: watch.agent, since: watch.createdAt };
}
const NAME_CHARS = 30;
const NAMED = ["等「", "」跑完"] as const;

export const jobWatchName = (command: string) => `${NAMED[0]}${command.slice(0, NAME_CHARS)}${NAMED[1]}`;

function jobCommand(name: string): string {
	return name.startsWith(NAMED[0]) && name.endsWith(NAMED[1]) ? name.slice(NAMED[0].length, -NAMED[1].length) : name;
}
const BACKGROUND_JOB = /goes on in the background as job:([0-9a-f]{8})/;

export function backgroundJobIn(output: string | undefined): string | undefined {
	const id = output?.match(BACKGROUND_JOB)?.[1];
	return id ? jobAgent(id) : undefined;
}
