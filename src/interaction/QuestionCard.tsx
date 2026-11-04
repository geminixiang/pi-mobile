import type { ToolCall } from "@earendil-works/pi-ai";
import { useContext, useState } from "react";
import { check } from "../agent/parse.ts";
import { InteractionContext } from "./context.ts";
import { AskArgs } from "./tool.ts";

const LETTERS = "ABCD";

export function QuestionCard({ call }: { call: ToolCall }) {
	const interaction = useContext(InteractionContext);
	const [tapped, setTapped] = useState<string>();
	const args = check(AskArgs, call.arguments, "ask_user");
	if (!args.ok) return null;
	const asked = interaction?.questions.get(call.id) ?? { state: "open" };
	const chosen = asked.state === "answered" ? args.value.options.find((option) => option === asked.answer) : tapped;
	return (
		<section className={`question ${asked.state}`}>
			<div className="question-card">
				<p className="question-text">{args.value.question}</p>
				<ol className="question-options">
					{args.value.options.map((option, index) =>
						asked.state === "answered" && chosen !== undefined && option !== chosen ? null : (
							<li key={option}>
								<button
									type="button"
									className={option === chosen ? "chosen" : undefined}
									disabled={asked.state === "answered" || tapped !== undefined || !interaction}
									onClick={() => {
										setTapped(option);
										interaction?.reply(option);
									}}
								>
									<span className="question-letter">{LETTERS[index]}</span>
									<span className="question-option">{option}</span>
								</button>
							</li>
						),
					)}
				</ol>
			</div>
			{asked.state === "open" ? <p className="question-hint">或在下方直接回答</p> : null}
		</section>
	);
}
