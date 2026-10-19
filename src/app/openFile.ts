// Lets tool steps in the transcript open a sandbox file in the workspace viewer.
import { createContext } from "react";
import { WORKSPACE } from "../agent/sandbox/workspace.ts";

export const OpenFileContext = createContext<((path: string) => void) | undefined>(undefined);

/** Tool paths are relative to the sandbox's working directory unless absolute. */
export function resolvePath(path: string): string {
	return path.startsWith("/") ? path : `${WORKSPACE}/${path.replace(/^\.\//, "")}`;
}
