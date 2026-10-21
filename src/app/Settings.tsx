import { App } from "@capacitor/app";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { KeepAlive, native } from "./keepAlive.ts";
import { Database, type TableInfo } from "../database-plugin.ts";
import { Notifications } from "../notifications-plugin.ts";
import { System } from "../system-plugin.ts";
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
import type { Settings } from "../settings.ts";
import { BackIcon } from "./icons.tsx";
import { MachinesGroup } from "./MachinesGroup.tsx";
import { McpGroup } from "./McpGroup.tsx";
import { PiMark } from "./PiMark.tsx";
import { TriggerRow } from "./TriggerRow.tsx";

type Check = { state: "idle" } | { state: "checking" } | { state: "ok"; detail: string } | { state: "error"; detail: string };

function CheckButton({ run, disabled }: { run: () => Promise<string>; disabled: boolean }) {
	const [check, setCheck] = useState<Check>({ state: "idle" });
	return (
		<div className="check">
			<button
				type="button"
				className="btn"
				disabled={disabled || check.state === "checking"}
				onClick={async () => {
					setCheck({ state: "checking" });
					try {
						setCheck({ state: "ok", detail: await run() });
					} catch (error) {
						setCheck({ state: "error", detail: error instanceof Error ? error.message : String(error) });
					}
				}}
			>
				{check.state === "checking" ? "測試中…" : "測試連線"}
			</button>
			{check.state === "ok" ? <span className="check-ok">{check.detail}</span> : null}
			{check.state === "error" ? <span className="check-error">{check.detail}</span> : null}
		</div>
	);
}


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
					<span className="menu-hint">在瀏覽器選帳號並同意，最後一頁會出現授權碼，複製後回到這裡</span>
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
			<p>在瀏覽器完成登入，複製最後一頁的授權碼，回到 app 會自動帶入。也可以貼在這裡：</p>
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
						<span className="menu-hint">在瀏覽器確認畫面上的代碼並同意，完成後會自動回到這裡</span>
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
			<p>在 Cloudflare 頁面確認這組代碼並按同意：</p>
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
						<span className="menu-hint">代碼會自動複製，在 Microsoft 的頁面貼上並同意即可</span>
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
			<p>代碼已複製。在 Microsoft 的頁面貼上這組代碼，選帳號並同意：</p>
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

	return (
		<Group
			title="行事曆"
			hint="agent 讀取的行程會送到模型服務；不想送出公司行程，就關掉那個帳號的「讀取」。新增活動只會寫進打開「寫入」的帳號，而且每次都會先問你。"
		>
			{calendars === undefined ? (
				<div className="check">
					<button type="button" className="btn" onClick={() => void load()}>
						讀取帳號清單
					</button>
					{error ? <span className="check-error">{error}</span> : null}
				</div>
			) : (
				<>
					{groups.map((group) => {
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
					})}
					{sharedCount > 0 ? (
						<div className="check-row">
							<span className="menu-text">
								分享的行事曆
								<span className="menu-hint">{sharedCount} 個你訂閱的，例如節日、同事或團隊的。只在你問起時讀取，不能寫入。</span>
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
		<Group
			title="排程"
			hint="跟 Bot 說「每天早上 8 點給我簡報」或「戴上耳機時跟我報告今天的事」，排程就會建在那個 Bot 底下，到時候在它的對話裡執行。pi 若不在執行中，會先跳通知，點一下才開始。每個排程一天最多執行 10 次。"
		>
			{state.items.length === 0 ? (
				<div className="check-row">
					<span className="menu-text">
						還沒有排程
						<span className="menu-hint">例如「每天早上 8 點，看今天的行程和天氣，給我一段簡報」。</span>
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
						<span className="menu-hint">沒開時，排程可能晚幾分鐘才執行</span>
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
						<span className="menu-hint">沒開「鄰近裝置」權限時，只認得有線耳機，而且 pi 要在執行中</span>
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
	const row = (label: string, hint: string, on: boolean, fix: () => void) => (
		<div className="check-row">
			<span className="menu-text">
				{label}
				<span className="menu-hint">{hint}</span>
			</span>
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
		<Group title="背景執行" hint="agent 執行時，通知列會顯示「pi 工作中」，鎖上螢幕也會繼續跑。">
			{row("通知", "顯示執行中、完成和需要你確認", status.notifications, () =>
				void KeepAlive.requestNotifications().then(() => KeepAlive.status().then(setStatus)),
			)}
			{row("不受電池最佳化限制", "避免 Samsung 在長時間執行時讓 app 休眠", status.unrestrictedBattery, () =>
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
		<Group
			title="通知讀取"
			hint="開啟後，pi 會把其他 App 的通知（LINE、Messenger、信件、外送…）在手機上留 30 天，讓開了「通知」工具的 Bot 回答「剛剛誰找我」。只存在這支手機上；Bot 讀到的內容會送給模型。"
		>
			<div className="check-row">
				<span className="menu-text">
					通知存取權
					<span className="menu-hint">{allowed ? "在系統設定裡關掉就會停止記錄" : "在系統設定裡允許 pi mobile"}</span>
				</span>
				<button type="button" className="btn" onClick={() => void Notifications.openSettings()}>
					{allowed ? "管理" : "開啟"}
				</button>
			</div>
			{allowed ? (
				<div className="check-row">
					<span className="menu-text">
						清除記錄
						<span className="menu-hint">刪除目前留在手機上的通知</span>
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
		<Group
			title="資料庫"
			hint="開了「資料庫」工具的 Bot 可以在這支手機上的 SQLite 資料庫建表、記錄、查詢：記帳、清單、紀錄……所有 Bot 共用。刪除資料前會先問你。"
		>
			{tables.length === 0 ? (
				<div className="check-row">
					<span className="menu-text">
						還沒有資料表
						<span className="menu-hint">跟 Bot 說「幫我記帳：午餐 150」就會開始建立</span>
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
					<span className="menu-hint">整個資料庫檔（.db），可以備份，或用電腦上的 SQLite 工具開啟</span>
				</span>
				<button type="button" className="btn" onClick={() => void Database.export().catch((error: unknown) => showToast(`匯出失敗：${error instanceof Error ? error.message : String(error)}`))}>
					匯出
				</button>
			</div>
		</Group>
	);
}

export function SettingsView({
	initial,
	status,
	runtime,
	onSave,
	onCancel,
}: {
	initial: Settings;
	status?: string;
	/** The running agent, for what takes effect at once instead of on save (schedules). */
	runtime?: AgentRuntime;
	onSave: (settings: Settings) => void;
	onCancel?: () => void;
}) {
	const [settings, setSettings] = useState(initial);
	const changed = (Object.keys(initial) as (keyof Settings)[]).some((key) => initial[key] !== settings[key]);
	const field = (key: keyof Settings) => ({
		value: settings[key],
		onChange: (event: { target: { value: string } }) => setSettings({ ...settings, [key]: event.target.value.trim() }),
	});

	return (
		<div className="screen">
			<header className="bar">
				{onCancel ? (
					<button type="button" className="icon-button" onClick={onCancel} aria-label="返回">
						<BackIcon />
					</button>
				) : (
					<span className="bar-spacer" />
				)}
				<h1 className="bar-heading">設定</h1>
				<button
					type="button"
					className="btn primary"
					disabled={!settings.baseUrl || !settings.apiKey || (Boolean(onCancel) && !changed)}
					onClick={() => onSave(settings)}
				>
					{onCancel ? "儲存" : "開始"}
				</button>
			</header>
			<form className="settings" onSubmit={(event) => event.preventDefault()}>
				{onCancel ? null : (
					<div className="welcome">
						<PiMark size={36} />
						<h2>
							口袋裡的 agent，
							<br />
							只屬於<em>你</em>。
						</h2>
						<p>填上模型服務就能開始。對話和金鑰都只存在這支手機上。</p>
					</div>
				)}
				{status ? <div className="banner error">{status}</div> : null}
				<Group title="模型服務" hint="OpenAI 或 Anthropic 相容的 API 位址和 key，例如自架的 gateway、OpenAI、Anthropic。key 存在手機的 Keystore。">
					<label>
						<span>URL</span>
						<input {...field("baseUrl")} placeholder="http://100.x.y.z:8317" autoCapitalize="off" autoComplete="off" inputMode="url" />
					</label>
					<label>
						<span>API key</span>
						<input {...field("apiKey")} type="password" autoComplete="off" />
					</label>
					<CheckButton disabled={!settings.baseUrl || !settings.apiKey} run={() => checkModels(settings.baseUrl, settings.apiKey)} />
				</Group>

				<Group
					title="自動壓縮"
					hint="每個 Bot 只有一條一直延續的對話。內容超過這個大小時，較早的部分會自動壓縮成摘要，最近的內容保持原樣，每次請求的花費就不會一直變大。越小越省，但 Bot 記得的細節越少。模型能容納的比門檻小時，會在接近模型上限時壓縮。"
				>
					<label>
						<span>門檻</span>
						<select
							className="field"
							value={settings.compactAt}
							onChange={(event) => setSettings({ ...settings, compactAt: Number(event.target.value) })}
						>
							<option value={64_000}>64k tokens</option>
							<option value={128_000}>128k tokens</option>
							<option value={256_000}>256k tokens（建議）</option>
							<option value={512_000}>512k tokens</option>
							<option value={0}>模型上限</option>
						</select>
					</label>
					<div className="group-spacer" />
				</Group>

				<Group title="GitHub" hint="建議用 fine-grained token，只開需要的 repository 和權限。寫入前一定會先問你。">
					<label>
						<span>Token</span>
						<input {...field("githubToken")} type="password" autoComplete="off" placeholder="github_pat_…" />
					</label>
					<CheckButton disabled={!settings.githubToken} run={() => checkGitHub(settings.githubToken)} />
				</Group>

				<Group
					title="MCP"
					hint="連接提供 MCP 的服務，Bot 就能用它們的工具。需要登入的按「登入」，在瀏覽器完成。新加的服務不會給任何 Bot：在服務下面點選哪些 Bot 可以用，或在 Bot 面板的「連接的服務」裡開關。會改變東西的工具，執行前一定先問你。"
				>
					<McpGroup runtime={runtime} onError={(message) => showToast(message)} />
				</Group>

				{native ? (
					<Group
						title="機器"
						hint="用 SSH 連到你自己的電腦（Linux 或 Mac），agent 的 read、write、edit、bash 就在那裡執行。機器上只要有 SSH，app 會自己裝好 pi-env。選了機器就不會用下面的 relay。"
					>
						<MachinesGroup
							value={settings.machines}
							chosen={settings.sandboxMachine}
							onChange={(machines, sandboxMachine) => setSettings({ ...settings, machines, sandboxMachine })}
						/>
					</Group>
				) : null}

				<Group
					title="Sandbox relay"
					hint="所有 Bot 共用一個 Linux 容器，各有自己的資料夾，可以用 read、write、edit、bash，git 和 gh 也已登入你的 GitHub。留空就不啟用。"
				>
					{settings.sandboxUrl ? null : (
						<div className="pair-steps">
							<p>在要當 sandbox 的電腦（Mac 或 Linux，需要 Tailscale）上執行：</p>
							<pre className="console">sandbox/install.sh</pre>
							<p>裝好後用手機相機掃描它印出的 QR code，app 會自動填好。</p>
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
				<Group
					title="Google Cloud"
					hint="給 sandbox 裡的 gcloud 用。憑證留在手機上，只把一小時有效的 access token 交給 sandbox 的 proxy；會改動資源的請求要你先核准。"
				>
					{settings.gcloudCredential ? (
						<div className="check-row">
							<span className="menu-text">
								憑證
								<span className="menu-hint">{gcloudIdentity(settings.gcloudCredential)}</span>
							</span>
							<button type="button" className="btn" onClick={() => setSettings({ ...settings, gcloudCredential: "" })}>
								移除
							</button>
						</div>
					) : (
						<>
							<GoogleSignInPanel onCredential={(json) => setSettings((current) => ({ ...current, gcloudCredential: json }))} />
							<details className="manual">
								<summary>改用 service account 金鑰</summary>
								<label>
									<span>憑證 JSON</span>
									<textarea
										className="field json"
										rows={4}
										value={settings.gcloudCredential}
										onChange={(event) => setSettings({ ...settings, gcloudCredential: event.target.value.trim() })}
										placeholder="貼上 service account 金鑰，或 application_default_credentials.json"
										autoCapitalize="off"
										spellCheck={false}
									/>
								</label>
							</details>
						</>
					)}
					<label>
						<span>預設專案</span>
						<input {...field("gcloudProject")} placeholder="留空則用憑證本身的專案" autoCapitalize="off" autoComplete="off" />
					</label>
					<CheckButton disabled={!settings.gcloudCredential} run={() => checkGcloud(settings.gcloudCredential)} />
				</Group>
				<Group
					title="Cloudflare"
					hint="給 sandbox 裡的 cf 和 wrangler 用。登入後的 refresh token 留在手機上，只把短效的 access token 交給 sandbox 的 proxy；會改動資源的請求要你先核准。"
				>
					{settings.cloudflareCredential ? (
						<div className="check-row">
							<span className="menu-text">
								帳號
								<span className="menu-hint">{describeCloudflare(settings.cloudflareCredential)}</span>
							</span>
							<button type="button" className="btn" onClick={() => setSettings({ ...settings, cloudflareCredential: "" })}>
								移除
							</button>
						</div>
					) : (
						<>
							<CloudflareSignInPanel onCredential={(json) => setSettings((current) => ({ ...current, cloudflareCredential: json }))} />
							<details className="manual">
								<summary>改用 API token</summary>
								<label>
									<span>API token</span>
									<input
										type="password"
										autoComplete="off"
										onChange={(event) => {
											const token = event.target.value.trim();
											if (token.length >= 40) setSettings({ ...settings, cloudflareCredential: apiTokenCredential(token) });
										}}
									/>
								</label>
							</details>
						</>
					)}
				</Group>
				<Group
					title="Azure"
					hint="給 sandbox 裡的 az 用。refresh token 留在手機上，只把短效的 access token 交給 sandbox 的 proxy；會改動資源的請求要你先核准。"
				>
					{settings.azureCredential ? (
						<div className="check-row">
							<span className="menu-text">
								帳號
								<span className="menu-hint">{describeAzure(settings.azureCredential)}</span>
							</span>
							<button type="button" className="btn" onClick={() => setSettings({ ...settings, azureCredential: "" })}>
								移除
							</button>
						</div>
					) : (
						<AzureSignInPanel onCredential={(json) => setSettings((current) => ({ ...current, azureCredential: json }))} />
					)}
				</Group>
				<CalendarGroup value={settings.calendarAccess} onChange={(json) => setSettings((current) => ({ ...current, calendarAccess: json }))} />
				{runtime ? <TriggersGroup runtime={runtime} /> : null}
				<BackgroundGroup />
				<NotificationsGroup />
				<DatabaseGroup />
				<p className="about">pi mobile · {__BUILD__}</p>
			</form>
		</div>
	);
}
