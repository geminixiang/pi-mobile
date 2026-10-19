import type { ConfirmRequest } from "../agent/confirm.ts";
import { Sheet } from "./Sheet.tsx";

export function ConfirmDialog({ request, onAnswer }: { request: ConfirmRequest; onAnswer: (approved: boolean) => void }) {
	return (
		<Sheet title="允許這個操作？" modal>
			<div className="confirm-target">{request.title}</div>
			{request.detail ? <pre className="console">{request.detail}</pre> : null}
			<div className="actions">
				<button type="button" className="button" onClick={() => onAnswer(false)}>
					拒絕
				</button>
				<button type="button" className="button primary" onClick={() => onAnswer(true)}>
					允許
				</button>
			</div>
		</Sheet>
	);
}
