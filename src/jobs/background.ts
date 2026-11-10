export const WAIT_MS = 10_000;
export const BACKGROUND = "goes on in the background as job:";
const BACKGROUND_JOB = /goes on in the background as job:([0-9a-f]{8})/;

export function backgroundJobIn(output: string | undefined): string | undefined {
	const id = output?.match(BACKGROUND_JOB)?.[1];
	return id ? `job:${id}` : undefined;
}
