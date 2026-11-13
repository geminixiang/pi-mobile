import { createContext } from "react";

export type Beside = { inView: string | undefined };

export const BesideContext = createContext<Beside | undefined>(undefined);
