import { Layer } from "./Sheet.tsx";

export interface DialogRequest {
	title: string;
	body?: string;
	confirm: string;
	danger?: boolean;
}

export function Dialog({ request, onAnswer }: { request: DialogRequest | undefined; onAnswer: (sure: boolean) => void }) {
	const cancel = () => onAnswer(false);
	return (
		<Layer open={Boolean(request)} kind="dialog" onClose={cancel} label={request?.title}>
			<header className="strip">
				<span className="strip-title">{request?.title}</span>
			</header>
			<div className="dialog-body">{request?.body ? <p>{request.body}</p> : null}</div>
			<div className="dialog-actions">
				<button type="button" className="btn" onClick={cancel}>
					取消
				</button>
				<button type="button" className={`btn ${request?.danger ? "danger" : "primary"}`} onClick={() => onAnswer(true)}>
					{request?.confirm}
				</button>
			</div>
		</Layer>
	);
}
