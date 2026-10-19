// Bridge from tools to the UI: a tool asks, the UI shows a dialog, the tool continues with the answer.
// Without a UI listener (tests), every request is declined.

export interface ConfirmRequest {
	title: string;
	detail: string;
}

type Listener = (request: ConfirmRequest) => Promise<boolean>;

let listener: Listener | undefined;

export function setConfirmListener(next: Listener | undefined): void {
	listener = next;
}

export function requestConfirmation(request: ConfirmRequest): Promise<boolean> {
	return listener ? listener(request) : Promise.resolve(false);
}
