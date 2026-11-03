import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useBack, useLast } from "./layers.ts";

export interface DialogRequest {
	title: string;
	body?: string;
	confirm: string;
	danger?: boolean;
}

export function Dialog({ request, onAnswer }: { request: DialogRequest | undefined; onAnswer: (sure: boolean) => void }) {
	const cancel = () => onAnswer(false);
	const open = Boolean(request);
	useBack(open, cancel);
	const shown = useLast(open, request);
	return (
		<BaseDialog.Root open={open} onOpenChange={(next) => !next && cancel()}>
			<BaseDialog.Portal>
				<BaseDialog.Backdrop className="backdrop" />
				<BaseDialog.Popup className="layer-dialog" aria-label={shown?.title}>
					<header className="strip">
						<span className="strip-title">{shown?.title}</span>
					</header>
					<div className="dialog-body">{shown?.body ? <p>{shown.body}</p> : null}</div>
					<div className="dialog-actions">
						<button type="button" className="btn" onClick={cancel}>
							取消
						</button>
						<button type="button" className={`btn ${shown?.danger ? "danger" : "primary"}`} onClick={() => onAnswer(true)}>
							{shown?.confirm}
						</button>
					</div>
				</BaseDialog.Popup>
			</BaseDialog.Portal>
		</BaseDialog.Root>
	);
}
