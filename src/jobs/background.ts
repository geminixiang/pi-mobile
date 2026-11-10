export const WAIT_MS = 10_000;
export const BACKGROUND = "goes on in the background as job:";
const NAME_CHARS = 30;
const NAMED = ["等「", "」跑完"] as const;

export const jobWatchName = (command: string) => `${NAMED[0]}${command.slice(0, NAME_CHARS)}${NAMED[1]}`;

export function jobCommand(name: string): string {
	return name.startsWith(NAMED[0]) && name.endsWith(NAMED[1]) ? name.slice(NAMED[0].length, -NAMED[1].length) : name;
}
const BACKGROUND_JOB = /goes on in the background as job:([0-9a-f]{8})/;

export function backgroundJobIn(output: string | undefined): string | undefined {
	const id = output?.match(BACKGROUND_JOB)?.[1];
	return id ? `job:${id}` : undefined;
}
