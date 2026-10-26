import { App } from "@capacitor/app";
import { type ReactNode, useEffect, useState } from "react";
import { KeepAlive } from "./keepAlive.ts";
import { inApp, native, type NativePlugin } from "../native.ts";
import { Database, type TableInfo } from "../database-plugin.ts";
import { Notifications } from "../notifications-plugin.ts";
import { PhoneScreen } from "../phone-screen-plugin.ts";
import { PhoneState } from "../phone-state-plugin.ts";
import { System } from "../system-plugin.ts";
import { Usage } from "../agent/tools/records.ts";
import { Apps } from "../agent/tools/apps.ts";
import { recentLog } from "../log.ts";
import { useBriefly } from "./briefly.ts";
import { checkGitHub } from "../agent/checks.ts";
import { checkGcloud, describeGcloud } from "../agent/gcloud.ts";
import { describeAzure, finishAzureSignIn, startAzureSignIn } from "../agent/azure.ts";
import { apiTokenCredential, describeCloudflare, finishCloudflareSignIn, startCloudflareSignIn } from "../agent/cloudflare.ts";
import { DeviceSignInPanel, GoogleSignInPanel } from "./SignIn.tsx";
import { accountKey, type CalendarAccess } from "../agent/calendar-access.ts";
import { Calendar, groupByAccount, type PhoneCalendar } from "../agent/tools/calendar.ts";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Triggers, type TriggerState } from "../agent/triggers.ts";
import { changedKeys, isConfigured, type Settings } from "../settings.ts";
import { ChevronIcon } from "./icons.tsx";
import { BackButton } from "./BackButton.tsx";
import { useBack } from "./layers.ts";
import { pairedHosts, parseComputerKey } from "../agent/sandbox/host.ts";
import { HostsGroup } from "./HostsGroup.tsx";
import { providerName } from "../agent/providers.ts";
import { CheckButton } from "./CheckButton.tsx";
import { ProvidersGroup } from "./ProvidersGroup.tsx";
import { McpGroup, useMcp } from "./McpGroup.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { PiMark } from "./PiMark.tsx";
import { TriggerRow } from "./TriggerRow.tsx";
import { Segmented } from "./Segmented.tsx";
import { messageOf } from "../promise.ts";
import { toBase64 } from "../encoding.ts";

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

function SignedIn({ label, onRemove }: { label: string; onRemove: () => void }) {
	return (
		<div className="check-row">
			<span className="menu-text">{label}</span>
			<button type="button" className="btn" onClick={onRemove}>
				移除
			</button>
		</div>
	);
}

function CalendarGroup({ access, onChange }: { access: CalendarAccess; onChange: (access: CalendarAccess) => void }) {
	const [calendars, setCalendars] = useState<PhoneCalendar[]>();
	const [error, setError] = useState("");
	const load = () =>
		Calendar.listAccounts().then(
			({ calendars }) => setCalendars(calendars),
			(failure: unknown) => setError(messageOf(failure)),
		);
	useEffect(() => {
		if (!native.has("Calendar")) return;
		void Calendar.checkPermissions().then(({ calendar }) => {
			if (calendar === "granted") void load();
		});
	}, []);
	if (!native.has("Calendar")) return null;

	const toggle = (list: string[], key: string, on: boolean) => (on ? [...new Set([...list, key])] : list.filter((item) => item !== key));
	const groups = calendars ? groupByAccount(calendars) : [];
	const hiddenGroups = groups.filter((group) => access.hidden.includes(group.key));
	const sharedCount = calendars?.filter((calendar) => !calendar.own).length ?? 0;
	const writableTargets = (calendars ?? []).filter(
		(calendar) => calendar.writable && access.writable.includes(accountKey(calendar)) && !access.hidden.includes(accountKey(calendar)),
	);

	type Use = "off" | "read" | "write";
	const choose = (group: { key: string; calendars: PhoneCalendar[] }, use: Use) => {
		const ids = new Set(group.calendars.map((calendar) => calendar.id));
		const holdsDefault = access.defaultCalendar !== undefined && ids.has(access.defaultCalendar);
		const writeTarget = group.calendars.find((calendar) => calendar.writable && calendar.primary) ?? group.calendars.find((calendar) => calendar.writable);
		onChange({
			...access,
			hidden: toggle(access.hidden, group.key, use === "off"),
			writable: toggle(access.writable, group.key, use === "write"),
			defaultCalendar:
				use === "write" ? (access.defaultCalendar ?? writeTarget?.id) : holdsDefault ? undefined : access.defaultCalendar,
		});
	};

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
				<Segmented<Use>
					label={`${group.label} 的權限`}
					inline
					value={!readable ? "off" : access.writable.includes(group.key) ? "write" : "read"}
					options={[
						{ value: "off", label: "不用" },
						{ value: "read", label: "只讀" },
						{ value: "write", label: "讀寫", disabled: !canWrite },
					]}
					onChange={(use) => choose(group, use)}
				/>
			</div>
		);
	};

	return (
		<Group title="行事曆">
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
					{hiddenGroups.length > 0 ? (
						<details className="manual more-rows">
							<summary>其他 {hiddenGroups.length} 個帳號</summary>
							{hiddenGroups.map(accountRow)}
						</details>
					) : null}
					{sharedCount > 0 ? (
						<div className="check-row">
							<span className="menu-text">
								分享的行事曆
								<span className="menu-hint">{sharedCount} 個，只能讀</span>
							</span>
							<input type="checkbox" className="switch" aria-label="讀取分享的行事曆" checked={access.shared} onChange={(event) => onChange({ ...access, shared: event.target.checked })} />
						</div>
					) : null}
					{writableTargets.length > 0 ? (
						<label>
							<span>預設寫入</span>
							<select
								className="field"
								value={access.defaultCalendar ?? ""}
								onChange={(event) =>
									onChange({ ...access, defaultCalendar: event.target.value ? Number(event.target.value) : undefined })
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

function TriggersGroup({ runtime }: { runtime: AgentRuntime }) {
	const [state, setState] = useState<TriggerState>({ items: [], next: {} });
	const [bots, setBots] = useState<Bot[]>([]);
	const [exact, setExact] = useState<boolean>();
	const [bluetooth, setBluetooth] = useState<boolean>();
	const [error, setError] = useState("");
	useEffect(() => runtime.triggers.subscribe(setState), [runtime]);
	useEffect(() => runtime.subscribeBots(setBots), [runtime]);
	useEffect(() => {
		if (!native.has("Triggers")) return;
		const refresh = () =>
			void Triggers.status().then((status) => {
				setExact(status.exactAlarms);
				setBluetooth(status.bluetooth);
			});
		refresh();
		const listener = App.addListener("resume", () => {
			refresh();
			void runtime.triggers.sync();
		});
		return () => void listener.then((handle) => handle.remove());
	}, [runtime]);
	if (!native.has("Triggers")) return null;
	const headphones = state.items.some((item) => item.enabled && (item.when.kind === "headphones" || item.when.kind === "bluetooth"));
	const act = (action: Promise<unknown>) => action.catch((failure: unknown) => setError(messageOf(failure)));

	return (
		<Group title="自動化">
			{state.items.length === 0 ? (
				<div className="check-row">
					<span className="menu-text">
						還沒有自動化
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
					<span className="menu-text">偵測藍牙耳機</span>
					<button type="button" className="btn" onClick={() => void act(Triggers.requestBluetooth().then(({ granted }) => setBluetooth(granted)))}>
						開啟
					</button>
				</div>
			) : null}
			{error ? <div className="check"><span className="check-error">{error}</span></div> : null}
		</Group>
	);
}

function useRefreshOnResume(plugin: NativePlugin, refresh: () => void): void {
	useEffect(() => {
		if (!native.has(plugin)) return;
		refresh();
		const listener = App.addListener("resume", refresh);
		return () => void listener.then((handle) => handle.remove());
	}, []);
}

function SystemAccessGroup() {
	const [state, setState] = useState<{ usage: boolean; assistant: boolean; settings?: boolean }>();
	useRefreshOnResume("Usage", () =>
		void Promise.all([Usage.status(), System.assistant(), native.has("PhoneState") ? PhoneState.display() : undefined]).then(([usage, assistant, display]) =>
			setState({ usage: usage.allowed, assistant: assistant.held, ...(display ? { settings: display.canChange } : {}) }),
		),
	);
	if (!state) return null;
	const row = (label: string, hint: string | undefined, on: boolean, open: () => Promise<void>) => (
		<div className="check-row">
			<span className="menu-text">
				{label}
				{hint ? <span className="menu-hint">{hint}</span> : null}
			</span>
			<button type="button" className="btn" onClick={() => void open()}>
				{on ? "管理" : "開啟"}
			</button>
		</div>
	);
	return (
		<Group title="系統權限">
			{row("螢幕使用時間", state.usage ? undefined : "讓 Bot 看每個 app 用了多久", state.usage, () => Usage.openSettings())}
			{state.settings === undefined
				? null
				: row("修改系統設定", state.settings ? undefined : "讓 Bot 調螢幕亮度、自動旋轉、螢幕關閉時間", state.settings, () => PhoneState.openWriteSettings())}
			{row("數位助理", state.assistant ? "長按側邊鍵叫出 pi，帶著目前的畫面" : "設成數位助理，就能在任何畫面叫出 pi", state.assistant, () => System.openAssistantSettings())}
		</Group>
	);
}

function BackgroundGroup() {
	const [status, setStatus] = useState<{ notifications: boolean; unrestrictedBattery?: boolean }>();
	useRefreshOnResume("KeepAlive", () => void KeepAlive.status().then(setStatus));
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
			{status.unrestrictedBattery === undefined
				? null
				: row("不受電池最佳化限制", status.unrestrictedBattery, () => void KeepAlive.requestUnrestrictedBattery())}
		</Group>
	);
}

function NotificationsGroup() {
	const [allowed, setAllowed] = useState<boolean>();
	const [cleared, showCleared] = useBriefly();
	useRefreshOnResume("Notifications", () => void Notifications.status().then((status) => setAllowed(status.allowed)));
	if (allowed === undefined) return null;
	return (
		<Group title="通知讀取">
			<div className="check-row">
				<span className="menu-text">
					通知存取權
					{allowed ? <span className="menu-hint">保留 30 天</span> : null}
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
					<button type="button" className="btn" disabled={Boolean(cleared)} onClick={() => void Notifications.clear().then(() => showCleared("已清除"))}>
						{cleared ?? "清除"}
					</button>
				</div>
			) : null}
		</Group>
	);
}

function PhoneScreenGroup() {
	const [allowed, setAllowed] = useState<boolean>();
	useRefreshOnResume("PhoneScreen", () => void PhoneScreen.status().then((status) => setAllowed(status.allowed)));
	if (allowed === undefined) return null;
	return (
		<Group title="手機畫面">
			<div className="check-row">
				<span className="menu-text">
					無障礙服務
					{allowed ? null : <span className="menu-hint">開關是灰的：到 App 資訊 › ⋮ › 允許受限制的設定</span>}
				</span>
				{allowed ? null : (
					<button type="button" className="btn" onClick={() => void PhoneScreen.openAppInfo()}>
						App 資訊
					</button>
				)}
				<button type="button" className="btn" onClick={() => void PhoneScreen.openSettings()}>
					{allowed ? "管理" : "開啟"}
				</button>
			</div>
		</Group>
	);
}

function DatabaseGroup() {
	const [tables, setTables] = useState<TableInfo[]>();
	const [exportError, setExportError] = useState<string>();
	useEffect(() => {
		if (!native.has("Database")) return;
		void Database.schema().then((schema) => setTables(schema.tables));
	}, []);
	if (!tables) return null;
	return (
		<Group title="資料庫">
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
				<span className="menu-text">匯出</span>
				<button
					type="button"
					className="btn"
					onClick={() => {
						setExportError(undefined);
						void Database.export().catch((error: unknown) => setExportError(`匯出失敗：${messageOf(error)}`));
					}}
				>
					匯出
				</button>
			</div>
			{exportError ? <div className="note error">{exportError}</div> : null}
		</Group>
	);
}

const PHONE_PAGE: readonly NativePlugin[] = ["Calendar", "Notifications", "PhoneScreen", "Usage", "KeepAlive"];

type Page = "models" | "memory" | "accounts" | "services" | "machines" | "phone" | "schedules" | "data";

function SettingsIndex({ settings, runtime, onOpen }: { settings: Settings; runtime?: AgentRuntime; onOpen: (page: Page) => void }) {
	const [triggers, setTriggers] = useState<number>();
	const [tables, setTables] = useState<number>();
	const [memory, setMemory] = useState<number>();
	useEffect(() => runtime?.subscribeMemory({ kind: "global" }, (next) => setMemory(next.text.trim().length)), [runtime]);
	useEffect(() => runtime?.triggers.subscribe((state) => setTriggers(state.items.length)), [runtime]);
	useMcp(runtime);
	useEffect(() => {
		if (native.has("Database")) void Database.schema().then((schema) => setTables(schema.tables.length));
	}, []);
	const accounts = [
		settings.githubToken && "GitHub",
		settings.gcloudCredential && "Google Cloud",
		settings.cloudflareCredential && "Cloudflare",
		settings.azureCredential && "Azure",
	].filter(Boolean);
	const chosen = parseComputerKey(settings.computer);
	const host = settings.hosts.find((candidate) => candidate.id === chosen?.hostId);
	const services = runtime?.mcp.servers.length ?? 0;
	const rows: { page: Page; label: string; value: string | undefined }[] = [
		{ page: "models", label: "模型", value: settings.providers.map(providerName).join("、") },
		...(runtime ? [{ page: "memory" as const, label: "全域記憶", value: memory === undefined ? "" : memory ? `${memory} 字` : "空的" }] : []),
		{ page: "accounts", label: "帳號", value: accounts.join("、") },
		{ page: "services", label: "連接的服務", value: services ? `${services} 個` : "" },
		{ page: "machines", label: "電腦", value: host ? `${host.name}${chosen?.mode === "container" ? " · 容器" : ""}` : undefined },
		...(PHONE_PAGE.some((plugin) => native.has(plugin)) ? [{ page: "phone" as const, label: "手機", value: undefined }] : []),
		...(native.has("Triggers") ? [{ page: "schedules" as const, label: "自動化", value: triggers ? `${triggers} 個` : "" }] : []),
		...(native.has("Database") ? [{ page: "data" as const, label: "資料庫", value: tables === undefined ? "" : tables ? `${tables} 個資料表` : "空的" }] : []),
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

type TextSetting = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

async function shareDiagnostics(): Promise<void> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const body = `${JSON.stringify({ at: new Date().toISOString(), level: "info", event: "diagnostics.shared", build: __BUILD__ })}\n${recentLog()}`;
	await Apps.share({ title: "pi mobile 診斷記錄", fileBase64: toBase64(new TextEncoder().encode(body)), fileName: `pi-mobile-diagnostics-${stamp}.jsonl`, mimeType: "application/x-ndjson" });
}

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
	runtime?: AgentRuntime;
	onSave: (settings: Settings) => void;
	onDraft?: (settings: Settings, changed: boolean) => void;
	onCancel?: () => void;
}) {
	const [settings, setSettings] = useState(initial);
	const changed = changedKeys(initial, settings).length > 0;
	const field = (key: TextSetting) => ({
		value: settings[key],
		onChange: (event: { target: { value: string } }) => setSettings({ ...settings, [key]: event.target.value.trim() }),
	});

	useEffect(() => onDraft?.(settings, changed), [settings, changed, onDraft]);
	const [page, setPage] = useState<Page>();
	const [problem, setProblem] = useState<string>();
	const go = (next: Page | undefined) => {
		setProblem(undefined);
		setPage(next);
	};
	useBack(page !== undefined, () => go(undefined));
	const change = (next: Partial<Settings>) => setSettings((current) => ({ ...current, ...next }));

	const models = (
		<>
			<Group title="模型供應商">
				<ProvidersGroup settings={settings} models={runtime?.models ?? []} onChange={change} />
			</Group>
			{onCancel ? (
				<Group title="自動壓縮">
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
					<Group title="GitHub">
						<label>
							<span>Token</span>
							<input {...field("githubToken")} type="password" autoComplete="off" placeholder="github_pat_…" />
						</label>
						<CheckButton disabled={!settings.githubToken} run={() => checkGitHub(settings.githubToken)} />
					</Group>
					<Group title="Google Cloud">
						{settings.gcloudCredential ? (
							<SignedIn label={describeGcloud(settings.gcloudCredential)} onRemove={() => change({ gcloudCredential: "" })} />
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
							<SignedIn label={describeCloudflare(settings.cloudflareCredential)} onRemove={() => change({ cloudflareCredential: "" })} />
						) : (
							<>
								<DeviceSignInPanel provider="Cloudflare" start={startCloudflareSignIn} finish={finishCloudflareSignIn} onCredential={(json) => change({ cloudflareCredential: json })} />
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
							<SignedIn label={describeAzure(settings.azureCredential)} onRemove={() => change({ azureCredential: "" })} />
						) : (
							<DeviceSignInPanel provider="Microsoft" start={startAzureSignIn} finish={finishAzureSignIn} copyCode onCredential={(json) => change({ azureCredential: json })} />
						)}
					</Group>
				</>
			),
		},
		services: {
			title: "連接的服務",
			body: () => (
				<Group title="MCP">
					<McpGroup runtime={runtime} onError={setProblem} />
				</Group>
			),
		},
		machines: {
			title: "電腦",
			body: () => (
				<Group title="電腦">
					<HostsGroup
						hosts={pairedHosts(settings)}
						computer={settings.computer}
						onChange={(hosts, computer) =>
							setSettings((current) => ({
								...current,
								hosts: hosts.map(({ key: _key, ...host }) => host),
								hostKeys: Object.fromEntries(hosts.map((host) => [host.id, host.key])),
								computer,
							}))
						}
					/>
				</Group>
			),
		},
		phone: {
			title: "手機",
			body: () => (
				<>
					<CalendarGroup access={settings.calendarAccess} onChange={(calendarAccess) => change({ calendarAccess })} />
					<NotificationsGroup />
					<PhoneScreenGroup />
					<SystemAccessGroup />
					<BackgroundGroup />
				</>
			),
		},
		schedules: { title: "自動化", body: () => (runtime ? <TriggersGroup runtime={runtime} /> : null) },
		data: { title: "資料庫", body: () => <DatabaseGroup /> },
	};

	if (page === "memory" && runtime) {
		return <MemoryView runtime={runtime} scope={{ kind: "global" }} onClose={() => go(undefined)} onError={setProblem} />;
	}
	const current = page && page !== "memory" ? pages[page] : undefined;
	return (
		<div className="screen">
			<header className="bar">
				{current ? <BackButton onClick={() => go(undefined)} /> : onCancel ? <BackButton onClick={onCancel} /> : <span className="bar-spacer" />}
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
						<p>加入一個模型供應商就能開始。對話和金鑰都只存在{inApp ? "這支手機上" : "這個瀏覽器裡"}。</p>
					</div>
				)}
				{status ? <div className="banner error">{status}</div> : null}
				{problem ? <div className="banner error">{problem}</div> : null}
				{current ? current.body() : onCancel ? <SettingsIndex settings={settings} runtime={runtime} onOpen={go} /> : models}
				{current ? null : (
					<p className="about">
						pi mobile · {__BUILD__}
						{inApp ? (
							<>
								{" · "}
								<button type="button" className="link" onClick={() => void shareDiagnostics().catch((error: unknown) => setProblem(messageOf(error)))}>
									分享診斷記錄
								</button>
							</>
						) : null}
					</p>
				)}
			</form>
		</div>
	);
}
