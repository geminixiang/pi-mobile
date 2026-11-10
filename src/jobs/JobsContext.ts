import { createContext } from "react";

export type RunningJobs = { since: ReadonlyMap<string, number>; stop(job: string): Promise<void> };

export const JobsContext = createContext<RunningJobs | undefined>(undefined);
