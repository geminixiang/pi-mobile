import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { App } from "@capacitor/app";
import { CapacitorHttp } from "@capacitor/core";
import { McpClient, type McpFetch } from "@earendil-works/pi-mcp";
import { loadModels } from "../agent/available-models.ts";
import { refuseCleartextSecret } from "../net/cleartext.ts";
import { PhoneEnv, removePhoneFolder } from "../agent/files/phone-env.ts";
import { headerRecord, NULL_BODY_STATUS } from "../net/http.ts";
import { listenForRedirect } from "../agent/oauth.ts";
import type { Platform } from "../agent/platform.ts";
import { Browser } from "../browser/plugin.ts";
import { phonePermissions } from "../interaction/phone-permissions.ts";
import { inForeground } from "../keepAlive.ts";
import { inApp, native } from "../native.ts";
import { parseJson } from "../parse.ts";
import { Apps } from "../phone-apps/plugin.ts";
import { System } from "../plugins/system.ts";
import type { SettingsStorage, SettingsStore } from "../settings.ts";
import { orLogged } from "pi-mobile-base/promise";
import { MINUTE } from "pi-mobile-base/time";
import { Triggers } from "../triggers/plugin.ts";
import type { UiPlatform } from "pi-mobile-ui/platform";

const TIMEOUTS = { connectTimeout: 15_000, readTimeout: MINUTE };

const nativeFetch: McpFetch = async (input, init) => {
	const headers = headerRecord(init?.headers);
	let data: unknown;
	const body = init?.body;
	if (typeof body === "string") {
		data = (headers["content-type"] ?? "").includes("json") ? parseJson(body, "MCP 請求") : body;
	} else if (body instanceof URLSearchParams) {
		data = body.toString();
		headers["content-type"] ??= "application/x-www-form-urlencoded";
	} else if (body != null) {
		throw new Error("unsupported request body");
	}
	if (headers.authorization) refuseCleartextSecret(String(input));
	init?.signal?.throwIfAborted();
	const response = await CapacitorHttp.request({
		url: String(input),
		method: init?.method ?? "GET",
		headers,
		...(data === undefined ? {} : { data }),
		responseType: "text",
		...TIMEOUTS,
	});
	const text = typeof response.data === "string" ? response.data : response.data == null ? "" : JSON.stringify(response.data);
	return new Response(NULL_BODY_STATUS.has(response.status) ? null : text, { status: response.status, headers: response.headers });
};

export const capacitorStorage: SettingsStorage = {
	plain: {
		get: (key) => localStorage.getItem(key),
		set: (key, value) => localStorage.setItem(key, value),
		remove: (key) => localStorage.removeItem(key),
	},
	secrets: {
		get: async (key) => {
			if (!(await SecureStorage.keys()).includes(key)) return undefined;
			const stored = await SecureStorage.get(key);
			return typeof stored === "string" ? stored : undefined;
		},
		set: async (key, value) => {
			await SecureStorage.set(key, value);
		},
		remove: async (key) => {
			if ((await SecureStorage.keys()).includes(key)) await SecureStorage.remove(key);
		},
	},
};

export const capacitorUi: UiPlatform = {
	haptic: (kind) => {
		if (native.has("System")) void orLogged(System.haptic({ kind }), "haptics.failed", undefined);
	},
	onBack: (taken) => {
		if (!inApp) return () => undefined;
		const back = App.addListener("backButton", () => {
			if (!taken()) void App.minimizeApp();
		});
		return () => void back.then((handle) => handle.remove());
	},
	onResume: (run) => {
		const resume = App.addListener("resume", run);
		return () => void resume.then((handle) => handle.remove());
	},
	copy: (text) => navigator.clipboard.writeText(text),
	pasted: async () => (native.has("System") ? (await System.clipboardText()).text : navigator.clipboard.readText()),
};

export function capacitorPlatform(modelIds: Promise<Record<string, string[]>>, settings: SettingsStore): Platform {
	return {
		inApp,
		native,
		phone: native.has("BotFiles") ? { folder: (folder, network) => new PhoneEnv(folder, network), removeFolder: removePhoneFolder } : undefined,
		browser: native.implements(Browser.forget) ? { forget: (bot) => Browser.forget({ bot }) } : undefined,
		reports: native.implements(Triggers.seen) ? { forget: (conversation) => Triggers.seen({ conversation }) } : undefined,
		apps: native.implements(Apps.installed) ? { installed: async () => (await Apps.installed()).apps } : undefined,
		...capacitorStorage,
		settings,
		mcpClient: () => new McpClient({ name: "pi-mobile", version: "1.0.0" }),
		mcpFetch: nativeFetch,
		loopback: listenForRedirect,
		permissions: phonePermissions,
		inFront: inForeground,
		models: (current, compactAt, onReport) => loadModels(current, compactAt, modelIds, settings, onReport),
	};
}
