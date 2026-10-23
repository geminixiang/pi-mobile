import { createContext } from "react";

export const OpenFileContext = createContext<((path: string) => void) | undefined>(undefined);

export const joinPath = (base: string, name: string): string => (base.endsWith("/") ? `${base}${name}` : `${base}/${name}`);

export function resolvePath(root: string, path: string): string {
	return path.startsWith("/") ? path : joinPath(root, path.replace(/^\.\//, ""));
}
