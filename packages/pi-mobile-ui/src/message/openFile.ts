import { createContext } from "react";

export const OpenFileContext = createContext<((path: string) => void) | undefined>(undefined);
