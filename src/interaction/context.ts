import { createContext } from "react";
import type { FormAnswer } from "../agent/mcp-stateless.ts";
import type { Asked } from "./answers.ts";
import type { FormsState } from "./forms.ts";

export type Interaction = {
	questions: ReadonlyMap<string, Asked>;
	reply: (text: string) => void;
	forms: FormsState;
	answerForm: (callId: string, answer: FormAnswer) => void;
};

export const InteractionContext = createContext<Interaction | undefined>(undefined);
