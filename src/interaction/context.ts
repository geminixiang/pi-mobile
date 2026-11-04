import { createContext } from "react";
import type { Asked } from "./answers.ts";

export type Interaction = { questions: ReadonlyMap<string, Asked>; reply: (text: string) => void };

export const InteractionContext = createContext<Interaction | undefined>(undefined);
