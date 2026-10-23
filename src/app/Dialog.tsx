import { useEffect, useRef, useState } from "react";
import { Layer } from "./Sheet.tsx";

export interface DialogRequest {
	title: string;
	body?: string;
	confirm: string;
	cancel?: string;
	danger?: boolean;
	/** Present for a text prompt: the initial value. */
	input?: string;
}

/** In-app replacement for confirm() and prompt(): resolves true/false, or the entered text (undefined if cancelled). */
export type Ask = {
	(request: DialogRequest & { input: string }): Promise<string | undefined>;
	(request: DialogRequest): Promise<boolean>;
};

export function Dialog({ request, onAnswer }: { request: DialogRequest | undefined; onAnswer: (value: string | boolean | undefined) => void }) {
	const [value, setValue] = useState("");
	const field = useRef<HTMLInputElement>(null);
	const prompt = request?.input !== undefined;
	useEffect(() => {
		if (request?.input === undefined) return;
		setValue(request.input);
		setTimeout(() => field.current?.select(), 60);
	}, [request]);
	const cancel = () => onAnswer(prompt ? undefined : false);
	const accept = () => onAnswer(prompt ? value.trim() || undefined : true);
	return (
		<Layer open={Boolean(request)} kind="dialog" onClose={cancel} label={request?.title}>
			<header className="strip">
				<span className="strip-title">{request?.title}</span>
			</header>
			<div className="dialog-body">
				{request?.body ? <p>{request.body}</p> : null}
				{prompt ? (
					<input
						ref={field}
						className="field"
						value={value}
						onChange={(event) => setValue(event.target.value)}
						onKeyDown={(event) => event.key === "Enter" && accept()}
					/>
				) : null}
			</div>
			<div className="dialog-actions">
				<button type="button" className="btn" onClick={cancel}>
					{request?.cancel ?? "取消"}
				</button>
				<button type="button" className={`btn ${request?.danger ? "danger" : "primary"}`} onClick={accept}>
					{request?.confirm}
				</button>
			</div>
		</Layer>
	);
}
