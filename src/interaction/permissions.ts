import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { FormAnswer } from "../agent/mcp-stateless.ts";
import type { PendingForm } from "./forms.ts";

const PERMISSIONS = {
	contacts: { label: "聯絡人", why: "讓 Bot 讀這支手機的聯絡人" },
	calendar: { label: "日曆", why: "讓 Bot 讀和改這支手機的日曆" },
	photos: { label: "相片", why: "讓 Bot 看這支手機的相片" },
	calls: { label: "通話紀錄", why: "讓 Bot 讀這支手機的通話紀錄" },
	sms: { label: "簡訊", why: "讓 Bot 讀這支手機的簡訊" },
	location: { label: "位置", why: "讓 Bot 知道這支手機在哪裡" },
} as const;

export type PermissionKind = keyof typeof PERMISSIONS;

export type PermissionState = "granted" | "ask" | "denied" | "unknown";

export type PhonePermissions = {
	state(kind: PermissionKind): Promise<PermissionState>;
	request(kind: PermissionKind): Promise<boolean>;
};

export type AskForm = (callId: string, form: PendingForm, signal: AbortSignal | undefined) => Promise<FormAnswer>;

export function permissionGate(permissions: PhonePermissions, ask: AskForm) {
	const asking = new Map<string, Promise<void>>();
	const obtain = async (kind: PermissionKind, api: ToolExecutionApi, context: Context): Promise<void> => {
		const { label, why } = PERMISSIONS[kind];
		const answer = await ask(
			api.callId,
			{ conversationId: api.conversationId, service: label, confirm: "允許", accepted: "已允許", request: { message: why, schema: { type: "object", properties: {} } } },
			context.abortSignal,
		);
		if (answer.action === "cancel") throw new Error(`Nobody answered the request for ${kind} access. Answer without it, and say what you need it for.`);
		if (answer.action !== "accept" || !(await permissions.request(kind))) throw new Error(`The user did not allow ${kind} access. Answer without it, and do not ask again in this turn.`);
	};
	return async (kind: PermissionKind, api: ToolExecutionApi, context: Context): Promise<void> => {
		const state = await permissions.state(kind);
		if (state === "granted" || state === "unknown") return;
		if (state === "denied") throw new Error(`${kind} access is turned off for pi. Tell the user to allow it in the phone's 設定 › 應用程式 › pi › 權限.`);
		const key = `${String(api.conversationId)}:${kind}`;
		const running = asking.get(key) ?? obtain(kind, api, context).finally(() => asking.delete(key));
		asking.set(key, running);
		await running;
	};
}
