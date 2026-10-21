import { App } from "@capacitor/app";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { KeepAlive, native } from "./keepAlive.ts";
import { Database, type TableInfo } from "../database-plugin.ts";
import { Notifications } from "../notifications-plugin.ts";
import { System } from "../system-plugin.ts";
import { Usage } from "../agent/tools/records.ts";
import { showToast } from "./Toasts.tsx";
import { checkGitHub, checkModels, checkSandbox } from "../agent/checks.ts";
import {
	checkGcloud,
	describeCredential,
	finishGoogleSignIn,
	type GoogleSignIn,
	looksLikeAuthCode,
	parseCredential,
	startGoogleSignIn,
} from "../agent/gcloud.ts";
import { type AzureDeviceSignIn, describeAzure, finishAzureSignIn, startAzureSignIn } from "../agent/azure.ts";
import { apiTokenCredential, type DeviceSignIn, describeCloudflare, finishDeviceSignIn, startDeviceSignIn } from "../agent/cloudflare.ts";
import { accountKey, type CalendarAccess, parseCalendarAccess } from "../agent/calendar-access.ts";
import { Calendar, groupByAccount, type PhoneCalendar } from "../agent/tools/calendar.ts";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime, TriggerState } from "../agent/runtime.ts";
import { Triggers } from "../agent/triggers.ts";
import { isConfigured, type Settings } from "../settings.ts";
import { BackIcon, ChevronIcon } from "./icons.tsx";
import { useBack } from "./layers.ts";
import { parseMachines } from "../agent/sandbox/machine.ts";
import { parseProviders, providerName } from "../agent/providers.ts";
import { MachinesGroup } from "./MachinesGroup.tsx";
import { CheckButton } from "./CheckButton.tsx";
import { ProvidersGroup } from "./ProvidersGroup.tsx";
import { McpGroup } from "./McpGroup.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { PiMark } from "./PiMark.tsx";
import { TriggerRow } from "./TriggerRow.tsx";

/**
 * Sign in with Google: opens Google's consent page in the browser; its last page shows an authorization code. When the
 * user copies it and comes back, the app finds it on the clipboard; pasting by hand works too.
 */
function GoogleSignInPanel({ onCredential }: { onCredential: (json: string) => void }) {
	const [signIn, setSignIn] = useState<GoogleSignIn>();
	const [code, setCode] = useState("");
	const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; error: string }>({ kind: "idle" });

	const finish = async (value: string) => {
		if (!signIn || !value.trim()) return;
		setState({ kind: "busy" });
		try {
			onCredential(await finishGoogleSignIn(signIn, value));
			setSignIn(undefined);
			setCode("");
			setState({ kind: "idle" });
		} catch (error) {
			setState({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
		}
	};
	const finishRef = useRef(finish);
	finishRef.current = finish;

	useEffect(() => {
		if (!signIn) return;
		const listener = App.addListener("resume", async () => {
			// Android only lets the focused app read the clipboard, and focus arrives a moment after resume.
			await new Promise((resolve) => setTimeout(resolve, 400));
			const { text } = await System.clipboardText().catch(() => ({ text: "" }));
			if (looksLikeAuthCode(text)) {
				setCode(text.trim());
				void finishRef.current(text);
			}
		});
		return () => void listener.then((handle) => handle.remove());
	}, [signIn]);

	if (!signIn) {
		return (
			<div className="check-row">
				<span className="menu-text">
					用 Google 帳號登入
				</span>
				<button
					type="button"
					className="btn primary"
					onClick={async () => {
						const next = await startGoogleSignIn();
						setSignIn(next);
						setState({ kind: "idle" });
						await System.openExternal({ url: next.url });
					}}
				>
					登入
				</button>
			</div>
		);
	}
	return (
		<div className="sign-in">
			<p>複製最後一頁的授權碼，回來會自動帶入，或貼在這裡：</p>
			<input className="field" value={code} onChange={(event) => setCode(event.target.value)} placeholder="4/0A…" autoCapitalize="off" spellCheck={false} />
			{state.kind === "failed" ? <div className="check-error">{state.error}</div> : null}
			<div className="dialog-actions inline">
				<button type="button" className="btn" onClick={() => setSignIn(undefined)}>
					取消
				</button>
				<button type="button" className="btn primary" disabled={!code.trim() || state.kind === "busy"} onClick={() => void finish(code)}>
					{state.kind === "busy" ? "登入中…" : "完成"}
				</button>
			</div>
		</div>
	);
}

/** Cloudflare's device flow: show the code, open the approval page, and poll until the user approves it there. */
function CloudflareSignInPanel({ onCredential }: { onCredential: (json: string) => void }) {
	const [signIn, setSignIn] = useState<DeviceSignIn>();
	const [error, setError] = useState("");
	const abort = useRef<AbortController>(undefined);
	useEffect(() => () => abort.current?.abort(), []);

	const begin = async () => {
		setError("");
		try {
			const next = await startDeviceSignIn();
			setSignIn(next);
			const controller = new AbortController();
			abort.current = controller;
			await System.openExternal({ url: next.url });
			onCredential(await finishDeviceSignIn(next, controller.signal));
			setSignIn(undefined);
		} catch (failure) {
			setSignIn(undefined);
			if (!abort.current?.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
		}
	};

	if (!signIn) {
		return (
			<>
				<div className="check-row">
					<span className="menu-text">
						用 Cloudflare 帳號登入
					</span>
					<button type="button" className="btn primary" onClick={() => void begin()}>
						登入
					</button>
				</div>
				{error ? <div className="check-row check-error">{error}</div> : null}
			</>
		);
	}
	return (
		<div className="sign-in">
			<p>在 Cloudflare 頁面確認這組代碼：</p>
			<div className="user-code">{signIn.userCode}</div>
			<p className="ws-loading">等待授權</p>
			<div className="dialog-actions inline">
				<button
					type="button"
					className="btn"
					onClick={() => {
						abort.current?.abort();
						setSignIn(undefined);
					}}
				>
					取消
				</button>
				<button type="button" className="btn" onClick={() => void System.openExternal({ url: signIn.url })}>
					重新開啟頁面
				</button>
			</div>
		</div>
	);
}

/** Microsoft's device code flow: the code is copied for the user to paste at microsoft.com/devicelogin. */
function AzureSignInPanel({ onCredential }: { onCredential: (json: string) => void }) {
	const [signIn, setSignIn] = useState<AzureDeviceSignIn>();
	const [error, setError] = useState("");
	const abort = useRef<AbortController>(undefined);
	useEffect(() => () => abort.current?.abort(), []);

	const begin = async () => {
		setError("");
		try {
			const next = await startAzureSignIn();
			setSignIn(next);
			await navigator.clipboard.writeText(next.userCode).catch(() => undefined);
			const controller = new AbortController();
			abort.current = controller;
			await System.openExternal({ url: next.url });
			onCredential(await finishAzureSignIn(next, controller.signal));
			setSignIn(undefined);
		} catch (failure) {
			setSignIn(undefined);
			if (!abort.current?.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
		}
	};

	if (!signIn) {
		return (
			<>
				<div className="check-row">
					<span className="menu-text">
						用 Microsoft 帳號登入
					</span>
					<button type="button" className="btn primary" onClick={() => void begin()}>
						登入
					</button>
				</div>
				{error ? <div className="check-row check-error">{error}</div> : null}
			</>
		);
	}
	return (
		<div className="sign-in">
			<p>代碼已複製，在 Microsoft 的頁面貼上：</p>
			<div className="user-code">{signIn.userCode}</div>
			<p className="ws-loading">等待授權</p>
			<div className="dialog-actions inline">
				<button
					type="button"
					className="btn"
					onClick={() => {
						abort.current?.abort();
						setSignIn(undefined);
					}}
				>
					取消
				</button>
				<button type="button" className="btn" onClick={() => void System.openExternal({ url: signIn.url })}>
					重新開啟頁面
				</button>
			</div>
		</div>
	);
}

function gcloudIdentity(json: string): string {
	try {
		return describeCredential(parseCredential(json));
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<section className="group">
			<header className="strip">
				<span className="strip-title">{title}</span>
			</header>
			<div className="group-body">{children}</div>
			{hint ? <p className="hint">{hint}</p> : null}
		</section>
	);
}

/**
 * Per account: whether the agent may read its calendars and add events to them, the default calendar, and whether
 * shared calendars (colleagues', a team's) can be read. Reading the calendars needs the permission, asked on a tap.
 */
function CalendarGroup({ value, onChange }: { value: string; onChange: (json: string) => void }) {
	const [calendars, setCalendars] = useState<PhoneCalendar[]>();
	const [error, setError] = useState("");
	const access = parseCalendarAccess(value);
	const load = () =>
		Calendar.listAccounts().then(
			({ calendars }) => setCalendars(calendars),
			(failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
		);
	useEffect(() => {
		if (!native) return;
		void Calendar.checkPermissions().then(({ calendar }) => {
			if (calendar === "granted") void load();
		});
	}, []);
	if (!native) return null;

	const set = (next: CalendarAccess) => onChange(JSON.stringify(next));
	const toggle = (list: string[], key: string, on: boolean) => (on ? [...new Set([...list, key])] : list.filter((item) => item !== key));
	const groups = calendars ? groupByAccount(calendars) : [];
	const sharedCount = calendars?.filter((calendar) => !calendar.own).length ?? 0;
	const writableTargets = (calendars ?? []).filter(
		(calendar) => calendar.writable && access.writable.includes(accountKey(calendar)) && !access.hidden.includes(accountKey(calendar)),
	);

	const setWrite = (group: { key: string; calendars: PhoneCalendar[] }, on: boolean) => {
		const writable = toggle(access.writable, group.key, on);
		const ids = new Set(group.calendars.map((calendar) => calendar.id));
		let defaultCalendar = access.defaultCalendar;
		if (!on && defaultCalendar !== undefined && ids.has(defaultCalendar)) defaultCalendar = undefined;
		// The first account turned on becomes the default, so adding works without another step.
		if (on && defaultCalendar === undefined) {
			const target = group.calendars.find((calendar) => calendar.writable && calendar.primary) ?? group.calendars.find((c) => c.writable);
			defaultCalendar = target?.id;
		}
		set({ ...access, writable, defaultCalendar });
	};
	const setRead = (group: { key: string; calendars: PhoneCalendar[] }, on: boolean) => {
		if (on) {
			set({ ...access, hidden: toggle(access.hidden, group.key, false) });
			return;
		}
		// Hiding an account also stops writes to it.
		const holdsDefault = group.calendars.some((calendar) => calendar.id === access.defaultCalendar);
		set({
			...access,
			hidden: toggle(access.hidden, group.key, true),
			writable: toggle(access.writable, group.key, false),
			defaultCalendar: holdsDefault ? undefined : access.defaultCalendar,
		});
	};

	const switchButton = (label: string, on: boolean, change: (on: boolean) => void, disabled = false) => (
		<button type="button" className="toggle" aria-pressed={on} disabled={disabled} onClick={() => change(!on)}>
			{label}
		</button>
	);

	const accountRow = (group: { key: string; label: string; calendars: PhoneCalendar[] }) => {
		const readable = !access.hidden.includes(group.key);
		const canWrite = group.calendars.some((calendar) => calendar.writable);
		return (
			<div className="check-row" key={group.key}>
				<span className="menu-text">
					{group.label}
					{group.calendars.some((calendar) => !group.label.startsWith(calendar.name)) ? (
						<span className="menu-hint">{group.calendars.map((calendar) => calendar.name).join("、")}</span>
					) : null}
				</span>
				{switchButton("讀取", readable, (on) => setRead(group, on))}
				{switchButton("寫入", readable && access.writable.includes(group.key), (on) => setWrite(group, on), !readable || !canWrite)}
			</div>
		);
	};

	return (
		<Group title="行事曆" hint="Bot 讀到的行程會送給模型。">
			{calendars === undefined ? (
				<div className="check">
					<button type="button" className="btn" onClick={() => void load()}>
						讀取帳號清單
					</button>
					{error ? <span className="check-error">{error}</span> : null}
				</div>
			) : (
				<>
					{groups.filter((group) => !access.hidden.includes(group.key)).map(accountRow)}
					{groups.some((group) => access.hidden.includes(group.key)) ? (
						<details className="manual more-rows">
							<summary>其他 {groups.filter((group) => access.hidden.includes(group.key)).length} 個帳號</summary>
							{groups.filter((group) => access.hidden.includes(group.key)).map(accountRow)}
						</details>
					) : null}
					{sharedCount > 0 ? (
						<div className="check-row">
							<span className="menu-text">
								分享的行事曆
								<span className="menu-hint">{sharedCount} 個，只能讀</span>
							</span>
							{switchButton("讀取", access.shared, (on) => set({ ...access, shared: on }))}
						</div>
					) : null}
					{writableTargets.length > 0 ? (
						<label>
							<span>預設寫入</span>
							<select
								className="field"
								value={access.defaultCalendar ?? ""}
								onChange={(event) =>
									set({ ...access, defaultCalendar: event.target.value ? Number(event.target.value) : undefined })
								}
							>
								<option value="">每次問我</option>
								{writableTargets.map((calendar) => (
									<option key={calendar.id} value={calendar.id}>
										{calendar.name === calendar.account ? calendar.account : `${calendar.name} · ${calendar.account}`}
									</option>
								))}
							</select>
						</label>
					) : null}
				</>
			)}
		</Group>
	);
}

/**
 * Schedules and pending follow-ups the agent created: pause, run now, delete. They take effect at once (they are not
 * part of the form). Exact alarms make them fire on time; Android 14 and later turn that off for new apps.
 */
function TriggersGroup({ runtime }: { runtime: AgentRuntime }) {
	const [state, setState] = useState<TriggerState>({ items: [], next: {} });
	const [bots, setBots] = useState<Bot[]>([]);
	const [exact, setExact] = useState<boolean>();
	const [bluetooth, setBluetooth] = useState<boolean>();
	const [error, setError] = useState("");
	useEffect(() => runtime.subscribeTriggers(setState), [runtime]);
	useEffect(() => runtime.subscribeBots(setBots), [runtime]);
	useEffect(() => {
		if (!native) return;
		const refresh = () =>
			void Triggers.status().then((status) => {
				setExact(status.exactAlarms);
				setBluetooth(status.bluetooth);
			});
		refresh();
		const listener = App.addListener("resume", () => {
			refresh();
			void runtime.syncTriggers();
		});
		return () => void listener.then((handle) => handle.remove());
	}, [runtime]);
	if (!native) return null;
	const headphones = state.items.some((item) => item.enabled && item.when.kind === "headphones");
	const act = (action: Promise<unknown>) => action.catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));

	return (
		<Group title="排程">
			{state.items.length === 0 ? (
				<div className="check-row">
					<span className="menu-text">
						還沒有排程
						<span className="menu-hint">跟 Bot 說就會建立</span>
					</span>
				</div>
			) : (
				state.items.map((trigger) => (
					<TriggerRow
						key={trigger.id}
						trigger={trigger}
						next={state.next[trigger.id]}
						bot={bots.find((bot) => bot.id === trigger.conversationId) ?? "deleted"}
						runtime={runtime}
						onError={setError}
					/>
				))
			)}
			{exact === false ? (
				<div className="check-row">
					<span className="menu-text">
						準時執行
						<span className="menu-hint">沒開會晚幾分鐘</span>
					</span>
					<button type="button" className="btn" onClick={() => void Triggers.requestExactAlarms()}>
						開啟
					</button>
				</div>
			) : null}
			{headphones && bluetooth === false ? (
				<div className="check-row">
					<span className="menu-text">
						偵測藍牙耳機
						<span className="menu-hint">需要「鄰近裝置」權限</span>
					</span>
					<button type="button" className="btn" onClick={() => void act(Triggers.requestBluetooth().then(({ granted }) => setBluetooth(granted)))}>
						開啟
					</button>
				</div>
			) : null}
			{error ? <div className="check"><span className="check-error">{error}</span></div> : null}
		</Group>
	);
}

/**
 * The grants Android keeps in its own settings pages, which pi can only open: usage access (screen time) and pi as the
 * digital assistant. Rechecked when the user comes back from there.
 */
function SystemAccessGroup() {
	const [state, setState] = useState<{ usage: boolean; assistant: boolean }>();
	useEffect(() => {
		if (!native) return;
		const refresh = () =>
			void Promise.all([Usage.status(), System.assistant()]).then(([usage, assistant]) => setState({ usage: usage.allowed, assistant: assistant.held }));
		refresh();
		const listener = App.addListener("resume", refresh);
		return () => void listener.then((handle) => handle.remove());
	}, []);
	if (!state) return null;
	const row = (label: string, hint: string, on: boolean, open: () => Promise<void>) => (
		<div className="check-row">
			<span className="menu-text">
				{label}
				<span className="menu-hint">{hint}</span>
			</span>
			<button type="button" className="btn" onClick={() => void open()}>
				{on ? "管理" : "開啟"}
			</button>
		</div>
	);
	return (
		<Group title="系統權限">
			{row("螢幕使用時間", state.usage ? "已開啟" : "讓 Bot 看每個 app 用了多久", state.usage, () => Usage.openSettings())}
			{row("數位助理", state.assistant ? "長按側邊鍵叫出 pi，帶著目前的畫面" : "設成數位助理，就能在任何畫面叫出 pi", state.assistant, () => System.openAssistantSettings())}
		</Group>
	);
}

/** Notification permission and battery exemption, which background runs depend on. Rechecked when the app resumes. */
function BackgroundGroup() {
	const [status, setStatus] = useState<{ notifications: boolean; unrestrictedBattery: boolean }>();
	useEffect(() => {
		if (!native) return;
		const refresh = () => void KeepAlive.status().then(setStatus);
		refresh();
		const listener = App.addListener("resume", refresh);
		return () => void listener.then((handle) => handle.remove());
	}, []);
	if (!status) return null;
	const row = (label: string, on: boolean, fix: () => void) => (
		<div className="check-row">
			<span className="menu-text">{label}</span>
			{on ? (
				<span className="state on">已開啟</span>
			) : (
				<button type="button" className="btn" onClick={fix}>
					開啟
				</button>
			)}
		</div>
	);
	return (
		<Group title="背景執行">
			{row("通知", status.notifications, () =>
				void KeepAlive.requestNotifications().then(() => KeepAlive.status().then(setStatus)),
			)}
			{row("不受電池最佳化限制", status.unrestrictedBattery, () =>
				void KeepAlive.requestUnrestrictedBattery(),
			)}
		</Group>
	);
}

/**
 * Notification access, for bots with the 通知 toolset. Off until the user allows it in system settings; rechecked when
 * the app resumes, which is how the user comes back from there.
 */
function NotificationsGroup() {
	const [allowed, setAllowed] = useState<boolean>();
	useEffect(() => {
		if (!native) return;
		const refresh = () => void Notifications.status().then((status) => setAllowed(status.allowed));
		refresh();
		const listener = App.addListener("resume", refresh);
		return () => void listener.then((handle) => handle.remove());
	}, []);
	if (allowed === undefined) return null;
	return (
		<Group title="通知讀取">
			<div className="check-row">
				<span className="menu-text">
					通知存取權
					<span className="menu-hint">{allowed ? "保留 30 天" : "讓 Bot 讀其他 App 的通知"}</span>
				</span>
				<button type="button" className="btn" onClick={() => void Notifications.openSettings()}>
					{allowed ? "管理" : "開啟"}
				</button>
			</div>
			{allowed ? (
				<div className="check-row">
					<span className="menu-text">
						清除記錄
					</span>
					<button type="button" className="btn" onClick={() => void Notifications.clear().then(() => showToast("已清除通知記錄"))}>
						清除
					</button>
				</div>
			) : null}
		</Group>
	);
}

/** The bots' SQLite database: its tables and how full they are, and a copy to keep or open elsewhere. */
function DatabaseGroup() {
	const [tables, setTables] = useState<TableInfo[]>();
	useEffect(() => {
		if (!native) return;
		void Database.schema().then((schema) => setTables(schema.tables));
	}, []);
	if (!tables) return null;
	return (
		<Group title="資料庫" hint="所有 Bot 共用。">
			{tables.length === 0 ? (
				<div className="check-row">
					<span className="menu-text">
						還沒有資料表
					</span>
				</div>
			) : (
				tables.map((table) => (
					<div className="check-row" key={table.name}>
						<span className="menu-text">
							<code>{table.name}</code>
							<span className="menu-hint">{table.rows} 筆</span>
						</span>
					</div>
				))
			)}
			<div className="check-row">
				<span className="menu-text">
					匯出
					<span className="menu-hint">SQLite .db 檔</span>
				</span>
				<button type="button" className="btn" onClick={() => void Database.export().catch((error: unknown) => showToast(`匯出失敗：${error instanceof Error ? error.message : String(error)}`))}>
					匯出
				</button>
			</div>
		</Group>
	);
}

type Page = "models" | "memory" | "accounts" | "services" | "machines" | "phone" | "schedules" | "data";

/** One line per page, with what is set there on the right. */
function SettingsIndex({ settings, runtime, onOpen }: { settings: Settings; runtime?: AgentRuntime; onOpen: (page: Page) => void }) {
	const [triggers, setTriggers] = useState<number>();
	const [tables, setTables] = useState<number>();
	const [, setVersion] = useState(0);
	const [memory, setMemory] = useState<number>();
	useEffect(() => runtime?.subscribeMemory({ kind: "global" }, (next) => setMemory(next.text.trim().length)), [runtime]);
	useEffect(() => runtime?.subscribeTriggers((state) => setTriggers(state.items.length)), [runtime]);
	useEffect(() => runtime?.mcp.subscribe(() => setVersion((version) => version + 1)), [runtime]);
	useEffect(() => {
		if (native) void Database.schema().then((schema) => setTables(schema.tables.length));
	}, []);
	const accounts = [
		settings.githubToken && "GitHub",
		settings.gcloudCredential && "Google Cloud",
		settings.cloudflareCredential && "Cloudflare",
		settings.azureCredential && "Azure",
	].filter(Boolean);
	const machine = parseMachines(settings.machines).find((candidate) => candidate.id === settings.sandboxMachine);
	const relay = settings.sandboxUrl ? new URL(settings.sandboxUrl.replace(/^ws/, "http")).hostname : "";
	const services = runtime?.mcp.servers.length ?? 0;
	const rows: { page: Page; label: string; value: string | undefined }[] = [
		{ page: "models", label: "模型", value: parseProviders(settings.providers).map(providerName).join("、") },
		...(runtime ? [{ page: "memory" as const, label: "全域記憶", value: memory === undefined ? "" : memory ? `${memory} 字` : "空的" }] : []),
		{ page: "accounts", label: "帳號", value: accounts.join("、") },
		{ page: "services", label: "連接的服務", value: services ? `${services} 個` : "" },
		{ page: "machines", label: "電腦", value: machine?.name ?? relay },
		...(native
			? [
					{ page: "phone" as const, label: "手機", value: undefined },
					{ page: "schedules" as const, label: "排程", value: triggers ? `${triggers} 個` : "" },
					{ page: "data" as const, label: "資料庫", value: tables === undefined ? "" : tables ? `${tables} 個資料表` : "空的" },
				]
			: []),
	];
	return (
		<nav className="menu settings-index">
			{rows.map((row) => (
				<button type="button" key={row.page} onClick={() => onOpen(row.page)}>
					<span className="menu-text">{row.label}</span>
					{row.value === undefined ? null : <span className="index-value">{row.value || "未設定"}</span>}
					<ChevronIcon />
				</button>
			))}
		</nav>
	);
}

/** The settings that are text, which field() binds to an input. */
type TextSetting = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

export function SettingsView({
	initial,
	status,
	runtime,
	onSave,
	onDraft,
	onCancel,
}: {
	initial: Settings;
	status?: string;
	/** The running agent, for what takes effect at once instead of on save (schedules). */
	runtime?: AgentRuntime;
	/** First run: 開始 saves and starts. */
	onSave: (settings: Settings) => void;
	/** Opened from the app: every edit, so leaving can save it; there is no save button. */
	onDraft?: (settings: Settings, changed: boolean) => void;
	onCancel?: () => void;
}) {
	const [settings, setSettings] = useState(initial);
	const changed =
		(Object.keys(initial) as (keyof Settings)[]).some((key) => key !== "providerKeys" && key !== "providerOAuth" && initial[key] !== settings[key]) ||
		JSON.stringify(initial.providerKeys) !== JSON.stringify(settings.providerKeys) ||
		JSON.stringify(initial.providerOAuth) !== JSON.stringify(settings.providerOAuth);
	const field = (key: TextSetting) => ({
		value: settings[key],
		onChange: (event: { target: { value: string } }) => setSettings({ ...settings, [key]: event.target.value.trim() }),
	});

	useEffect(() => onDraft?.(settings, changed), [settings, changed, onDraft]);
	const [page, setPage] = useState<Page>();
	useBack(page !== undefined, () => setPage(undefined));
	const change = (next: Partial<Settings>) => setSettings((current) => ({ ...current, ...next }));

	const models = (
		<>
			<Group title="模型供應商">
				<ProvidersGroup settings={settings} models={runtime?.models ?? []} onChange={change} />
			</Group>
			{onCancel ? (
				<Group title="自動壓縮" hint="對話超過門檻時，較早的部分會壓縮成摘要。">
					<label>
						<span>門檻</span>
						<select className="field" value={settings.compactAt} onChange={(event) => change({ compactAt: Number(event.target.value) })}>
							<option value={64_000}>64k tokens</option>
							<option value={128_000}>128k tokens</option>
							<option value={256_000}>256k tokens（建議）</option>
							<option value={512_000}>512k tokens</option>
							<option value={0}>模型上限</option>
						</select>
					</label>
					<div className="group-spacer" />
				</Group>
			) : null}
		</>
	);

	const pages: Record<Exclude<Page, "memory">, { title: string; body: () => ReactNode }> = {
		models: { title: "模型", body: () => models },
		accounts: {
			title: "帳號",
			body: () => (
				<>
					<p className="page-note">憑證只存在這支手機。會改動東西的操作，每次都先問你。</p>
					<Group title="GitHub">
						<label>
							<span>Token</span>
							<input {...field("githubToken")} type="password" autoComplete="off" placeholder="github_pat_…" />
						</label>
						<CheckButton disabled={!settings.githubToken} run={() => checkGitHub(settings.githubToken)} />
					</Group>
					<Group title="Google Cloud">
						{settings.gcloudCredential ? (
							<div className="check-row">
								<span className="menu-text">
									{gcloudIdentity(settings.gcloudCredential)}
								</span>
								<button type="button" className="btn" onClick={() => change({ gcloudCredential: "" })}>
									移除
								</button>
							</div>
						) : (
							<>
								<GoogleSignInPanel onCredential={(json) => change({ gcloudCredential: json })} />
								<details className="manual">
									<summary>改用 service account 金鑰</summary>
									<label>
										<span>憑證 JSON</span>
										<textarea
											className="field json"
											rows={4}
											value={settings.gcloudCredential}
											onChange={(event) => change({ gcloudCredential: event.target.value.trim() })}
											placeholder="service account 金鑰或 application_default_credentials.json"
											autoCapitalize="off"
											spellCheck={false}
										/>
									</label>
								</details>
							</>
						)}
						<label>
							<span>預設專案</span>
							<input {...field("gcloudProject")} placeholder="憑證本身的專案" autoCapitalize="off" autoComplete="off" />
						</label>
						<CheckButton disabled={!settings.gcloudCredential} run={() => checkGcloud(settings.gcloudCredential)} />
					</Group>
					<Group title="Cloudflare">
						{settings.cloudflareCredential ? (
							<div className="check-row">
								<span className="menu-text">{describeCloudflare(settings.cloudflareCredential)}</span>
								<button type="button" className="btn" onClick={() => change({ cloudflareCredential: "" })}>
									移除
								</button>
							</div>
						) : (
							<>
								<CloudflareSignInPanel onCredential={(json) => change({ cloudflareCredential: json })} />
								<details className="manual">
									<summary>改用 API token</summary>
									<label>
										<span>API token</span>
										<input
											type="password"
											autoComplete="off"
											onChange={(event) => {
												const token = event.target.value.trim();
												if (token.length >= 40) change({ cloudflareCredential: apiTokenCredential(token) });
											}}
										/>
									</label>
								</details>
							</>
						)}
					</Group>
					<Group title="Azure">
						{settings.azureCredential ? (
							<div className="check-row">
								<span className="menu-text">{describeAzure(settings.azureCredential)}</span>
								<button type="button" className="btn" onClick={() => change({ azureCredential: "" })}>
									移除
								</button>
							</div>
						) : (
							<AzureSignInPanel onCredential={(json) => change({ azureCredential: json })} />
						)}
					</Group>
				</>
			),
		},
		services: {
			title: "連接的服務",
			body: () => (
				<Group title="MCP" hint="新加的服務不會給任何 Bot，在服務下面選哪些 Bot 可以用。">
					<McpGroup runtime={runtime} onError={(message) => showToast(message)} />
				</Group>
			),
		},
		machines: {
			title: "電腦",
			body: () => (
				<>
					{native ? (
						<Group title="SSH 機器">
							<MachinesGroup
								value={settings.machines}
								chosen={settings.sandboxMachine}
								onChange={(machines, sandboxMachine) => change({ machines, sandboxMachine })}
							/>
						</Group>
					) : null}
					<Group title="Sandbox relay" hint={settings.sandboxMachine ? "已選了 SSH 機器，不會用 relay。" : undefined}>
						{settings.sandboxUrl ? null : (
							<div className="pair-steps">
								<p>在電腦上執行，再用相機掃它印出的 QR code：</p>
								<pre className="console">sandbox/install.sh</pre>
							</div>
						)}
						<details className="manual" open={Boolean(settings.sandboxUrl)}>
							<summary>{settings.sandboxUrl ? "目前的主機" : "手動輸入"}</summary>
							<label>
								<span>Relay</span>
								<input {...field("sandboxUrl")} placeholder="ws://100.x.y.z:8787" autoCapitalize="off" autoComplete="off" inputMode="url" />
							</label>
							<label>
								<span>Token</span>
								<input {...field("sandboxToken")} type="password" autoComplete="off" />
							</label>
						</details>
						<CheckButton disabled={!settings.sandboxUrl || !settings.sandboxToken} run={() => checkSandbox(settings.sandboxUrl, settings.sandboxToken)} />
					</Group>
				</>
			),
		},
		phone: {
			title: "手機",
			body: () => (
				<>
					<CalendarGroup value={settings.calendarAccess} onChange={(json) => change({ calendarAccess: json })} />
					<NotificationsGroup />
					<SystemAccessGroup />
					<BackgroundGroup />
				</>
			),
		},
		schedules: { title: "排程", body: () => (runtime ? <TriggersGroup runtime={runtime} /> : null) },
		data: { title: "資料庫", body: () => <DatabaseGroup /> },
	};

	// The global MEMORY.md is its own page with its own bar (MemoryView), the same one a bot's memory uses.
	if (page === "memory" && runtime) {
		return <MemoryView runtime={runtime} scope={{ kind: "global" }} onClose={() => setPage(undefined)} onError={(message) => showToast(message)} />;
	}
	const current = page && page !== "memory" ? pages[page] : undefined;
	return (
		<div className="screen">
			<header className="bar">
				{current ? (
					<button type="button" className="icon-button" onClick={() => setPage(undefined)} aria-label="返回">
						<BackIcon />
					</button>
				) : onCancel ? (
					<button type="button" className="icon-button" onClick={onCancel} aria-label="返回">
						<BackIcon />
					</button>
				) : (
					<span className="bar-spacer" />
				)}
				<h1 className="bar-heading">{current?.title ?? "設定"}</h1>
				{onCancel ? (
					<span className="bar-spacer" />
				) : (
					<button type="button" className="btn primary" disabled={!isConfigured(settings)} onClick={() => onSave(settings)}>
						開始
					</button>
				)}
			</header>
			<form key={page ?? "index"} className="settings" onSubmit={(event) => event.preventDefault()}>
				{onCancel ? null : (
					<div className="welcome">
						<PiMark size={36} />
						<h2>
							口袋裡的 agent，
							<br />
							只屬於<em>你</em>。
						</h2>
						<p>加入一個模型供應商就能開始。對話和金鑰都只存在這支手機上。</p>
					</div>
				)}
				{status ? <div className="banner error">{status}</div> : null}
				{current ? current.body() : onCancel ? <SettingsIndex settings={settings} runtime={runtime} onOpen={setPage} /> : models}
				{current ? null : <p className="about">pi mobile · {__BUILD__}</p>}
			</form>
		</div>
	);
}
