import { toBase64 } from "../encoding.ts";
import { recentLog, saveLogWith } from "../log.ts";
import { native } from "../native.ts";
import { Apps } from "../plugins/apps.ts";
import { System } from "../plugins/system.ts";
import { messageOf } from "../promise.ts";

export function keepLogOnDevice(): void {
	if (!native.implements(System.appendLog)) return;
	saveLogWith((lines) => {
		void System.appendLog({ lines }).catch((error: unknown) => console.warn(messageOf(error)));
	});
}

export async function shareDiagnostics(): Promise<void> {
	const saved = native.implements(System.readLog) ? (await System.readLog()).text : recentLog();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const body = `${JSON.stringify({ at: new Date().toISOString(), level: "info", event: "diagnostics.shared", build: __BUILD__ })}\n${saved}`;
	await Apps.share({ title: "pi mobile 診斷記錄", fileBase64: toBase64(new TextEncoder().encode(body)), fileName: `pi-mobile-diagnostics-${stamp}.jsonl`, mimeType: "application/x-ndjson" });
}
