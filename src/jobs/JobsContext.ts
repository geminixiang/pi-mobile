import { createContext, useEffect, useState } from "react";

export type RunningJob = { job: string; since: number; label: string };
export type Peek = { command: string; output: string };
export type RunningJobs = { jobs: readonly RunningJob[]; stop(job: string): Promise<void>; peek(job: string): Promise<Peek | undefined> };

export const JobsContext = createContext<RunningJobs | undefined>(undefined);

export function useNow(ticking: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!ticking) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [ticking]);
	return now;
}

export function clock(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
