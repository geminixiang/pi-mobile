import { createContext } from "react";

type Beside = { inView: string | undefined; part: string | undefined; clearPart: () => void };

export const BesideContext = createContext<Beside | undefined>(undefined);
