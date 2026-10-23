import { createContext } from "react";

export const OpenFileContext = createContext<((path: string) => void) | undefined>(undefined);

export function resolvePath(root: string, path: string): string {
	return path.startsWith("/") ? path : `${root}/${path.replace(/^\.\//, "")}`;
}
