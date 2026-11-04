import { useContext, useState } from "react";
import { ChevronIcon } from "../app/icons.tsx";
import { InteractionContext } from "./context.ts";
import type { Outcome, SettledForm } from "./forms.ts";

const OUTCOME: Record<Outcome, string> = { accepted: "已確認", declined: "已取消", skipped: "已略過", cancelled: "已中斷" };

export function FormCard({ callId }: { callId: string }) {
	const interaction = useContext(InteractionContext);
	const [sent, setSent] = useState(false);
	const form = interaction?.forms.pending.get(callId);
	if (!interaction || !form) return null;
	const fields = Object.entries(form.request.schema.properties);
	const confirmable = fields.every(([, field]) => field.type === "boolean");
	const answer = (accept: boolean) => {
		setSent(true);
		interaction.answerForm(
			callId,
			accept ? { action: "accept", content: Object.fromEntries(fields.map(([key]) => [key, true])) } : { action: "decline" },
		);
	};
	return (
		<section className="form-card">
			<div className="question-card">
				<p className="form-service">{form.service}</p>
				<p className="form-message">{form.request.message}</p>
				{confirmable ? null : <p className="form-unsupported">pi 還不能填這種表單，只能取消</p>}
				<div className="form-actions">
					<button type="button" className="form-button" disabled={sent} onClick={() => answer(false)}>
						取消
					</button>
					{confirmable ? (
						<button type="button" className="form-button primary" disabled={sent} onClick={() => answer(true)}>
							確認
						</button>
					) : null}
				</div>
			</div>
			<p className="question-hint">或在下方直接回答，就不會送出</p>
		</section>
	);
}

export function FormRecord({ form }: { form: SettledForm }) {
	const [open, setOpen] = useState(false);
	return (
		<section className="form-card">
			<button type="button" className={`question-card form-record${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="form-record-head">
					<span className="form-record-service">{form.service}</span>
					<span className="form-record-outcome">{OUTCOME[form.outcome]}</span>
					<ChevronIcon open={open} size={12} />
				</span>
				{open ? <span className="form-message">{form.message}</span> : null}
			</button>
		</section>
	);
}
