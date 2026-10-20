// Lets tool steps in the transcript open a sandbox file in the workspace viewer.
import { createContext } from "react";

export const OpenFileContext = createContext<((path: string) => void) | undefined>(undefined);

/** Tool paths are relative to the sandbox's working directory unless absolute. */
export function resolvePath(root: string, path: string): string {
	return path.startsWith("/") ? path : `${root}/${path.replace(/^\.\//, "")}`;
}
