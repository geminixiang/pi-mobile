import { platform } from "./platform.ts";

export function copy(text: string): Promise<void> {
	return platform().copy(text);
}

export function pasted(): Promise<string> {
	return platform().pasted();
}
