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
				<BaseDialog.Backdrop className="backdrop" data-layer />
				<BaseDialog.Popup className="layer-dialog" data-layer>
					<BaseDialog.Title className="dialog-title">{shown?.title}</BaseDialog.Title>
					{shown?.body ? <BaseDialog.Description className="dialog-text">{shown.body}</BaseDialog.Description> : null}
					<div className="dialog-choices">
						<button type="button" className="dialog-choice" onClick={cancel}>
							取消
						</button>
						<button type="button" className={`dialog-choice ${shown?.danger ? "danger" : "primary"}`} onClick={() => onAnswer(true)}>
							{shown?.confirm}
						</button>
					</div>
				</BaseDialog.Popup>
			</BaseDialog.Portal>
		</BaseDialog.Root>
	);
}
