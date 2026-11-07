import type { ToolCall } from "@earendil-works/pi-ai";
import { useContext } from "react";
import { InteractionContext } from "./context.ts";
import { FormCard, FormRecord } from "./FormCard.tsx";
import { stepOf } from "./forms.ts";
import { QuestionCard } from "./QuestionCard.tsx";
import { AlertCard, PageCard, WeatherCard } from "./ResultCards.tsx";
import { ASK_USER } from "./tool.ts";

const MOST_PER_STEP = 2;

export function InteractionCard({ call }: { call: ToolCall }) {
	const interaction = useContext(InteractionContext);
	if (call.name === ASK_USER) return <QuestionCard call={call} />;
	if (!interaction) return null;
	const settled = [...interaction.forms.settled.values()].flat().filter((form) => form.step === call.id);
	const pending = [...interaction.forms.pending.keys()].filter((callId) => stepOf(callId) === call.id);
	const page = interaction.pages.get(call.id);
	return (
		<>
			{interaction.results.filter((card) => card.step === call.id).slice(-MOST_PER_STEP).map((card) => (
				card.kind === "alert" ? <AlertCard key="alert" card={card} /> : <WeatherCard key={card.place} card={card} />
			))}
			{page ? <PageCard page={page} /> : null}
			{settled.map((form) => (
				<FormRecord key={form.at} form={form} />
			))}
			{pending.map((callId) => (
				<FormCard key={callId} callId={callId} />
			))}
		</>
	);
}
