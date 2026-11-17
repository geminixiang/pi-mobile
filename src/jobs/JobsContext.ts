import { createContext } from "react";
import { every, pad } from "../time.ts";
import { useSubscribed } from "../ui/subscribed.ts";

export type RunningJob = { job: string; since: number; label: string };
type Peek = { command: string; output: string };
export type RunningJobs = { jobs: readonly RunningJob[]; stop(job: string): Promise<void>; peek(job: string): Promise<Peek | undefined> };

export const JobsContext = createContext<RunningJobs | undefined>(undefined);

export function useNow(ticking: boolean): number {
	return useSubscribed(Date.now(), (listener) => (ticking ? every(1000, () => listener(Date.now())) : undefined), [ticking]);
}

export function clock(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}
