import { toBase64 } from "../encoding.ts";
import { recentLog } from "../log.ts";
import { Apps } from "../plugins/apps.ts";

export async function shareDiagnostics(): Promise<void> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const body = `${JSON.stringify({ at: new Date().toISOString(), level: "info", event: "diagnostics.shared", build: __BUILD__ })}\n${recentLog()}`;
	await Apps.share({ title: "pi mobile 診斷記錄", fileBase64: toBase64(new TextEncoder().encode(body)), fileName: `pi-mobile-diagnostics-${stamp}.jsonl`, mimeType: "application/x-ndjson" });
}
