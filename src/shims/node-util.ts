const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripVTControlCharacters(text: string): string {
	return text.replace(ANSI_SEQUENCE, "");
}
