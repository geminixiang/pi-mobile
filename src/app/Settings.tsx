import { Row } from "./Row.tsx";
import { App } from "@capacitor/app";
import { type ReactNode, useEffect, useState } from "react";
import { KeepAlive } from "../plugins/keep-alive.ts";
import { inApp, native, type NativePlugin } from "../native.ts";
import { Database } from "../plugins/database.ts";
import { Notifications } from "../plugins/notifications.ts";
import { PhoneScreen } from "../phone-screen/plugin.ts";
import { PhoneState } from "../plugins/phone-state.ts";
import { System } from "../plugins/system.ts";
import { Usage } from "../plugins/usage.ts";
import { shareDiagnostics } from "./diagnostics.ts";
import { useBriefly } from "./briefly.ts";
import { checkGitHub } from "../agent/checks.ts";
import { checkGcloud, describeGcloud } from "../agent/gcloud.ts";
import { describeAzure, finishAzureSignIn, startAzureSignIn } from "../agent/azure.ts";
import { apiTokenCredential, describeCloudflare, finishCloudflareSignIn, startCloudflareSignIn } from "../agent/cloudflare.ts";
import { DeviceSignInPanel, GoogleSignInPanel } from "./SignIn.tsx";
import { type CalendarAccess, canWrite, groupByAccount } from "../agent/calendar-access.ts";
import { Calendar, type PhoneCalendar } from "../plugins/calendar.ts";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { TriggerState } from "../triggers/runs.ts";
import { Triggers } from "../triggers/plugin.ts";
import { changedKeys, isConfigured, SEARCH_ENGINES, type SearchEngine, type Settings } from "../settings.ts";
import { AutomationIcon, DatabaseIcon, EyeIcon, GlobeIcon, KeyIcon, MemoryIcon, ModelIcon, PhoneIcon, PlugIcon, TerminalIcon } from "./icons.tsx";
import { BackButton } from "./BackButton.tsx";
import { useBack } from "./layers.ts";
import { pairedHosts } from "../agent/sandbox/host.ts";
import { HostsGroup } from "./HostsGroup.tsx";
import { CheckButton } from "./CheckButton.tsx";
import { ProvidersGroup } from "./ProvidersGroup.tsx";
import { ChoiceRow } from "./ChoiceRow.tsx";
import { McpGroup, useMcp } from "./McpGroup.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { PiMark } from "./PiMark.tsx";
import { TriggerList } from "../triggers/TriggerList.tsx";
import { grouped } from "../triggers/when.ts";
import { DAY, startOfToday } from "../agent/tools/common.ts";
import { shortModelName } from "./ModelSheet.tsx";
import { Segmented } from "./Segmented.tsx";
import { useLoaded } from "./loaded.ts";
import { messageOf, orLogged } from "../promise.ts";
import { checkForUpdate, installUpdate, type Update } from "./update.ts";
import type { Prefs } from "./prefs.ts";

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="group">
			<header className="strip">
				<span className="strip-title">{title}</span>
			</header>
			<div className="group-body">{children}</div>
		</section>
	);
}

function SignedIn({ label, onRemove }: { label: string; onRemove: () => void }) {
	return (
		<Row label={label}>
			<button type="button" className="btn" onClick={onRemove}>
				移除
			</button>
		</Row>
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
	const writableTargets = (calendars ?? []).filter((calendar) => calendar.writable && canWrite(access, calendar));

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
		const writable = group.calendars.some((calendar) => calendar.writable);
		return (
			<Row
				key={group.key}
				label={group.label}
				hint={group.calendars.some((calendar) => !group.label.startsWith(calendar.name)) ? group.calendars.map((calendar) => calendar.name).join("、") : undefined}
			>
				<Segmented<Use>
					label={`${group.label} 的權限`}
					inline
					value={!readable ? "off" : access.writable.includes(group.key) ? "write" : "read"}
					options={[
						{ value: "off", label: "不用" },
						{ value: "read", label: "只讀" },
						{ value: "write", label: "讀寫", disabled: !writable },
					]}
					onChange={(use) => choose(group, use)}
				/>
			</Row>
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
						<Row label="分享的行事曆" hint={`${sharedCount} 個，只能讀`}>
							<input type="checkbox" className="switch" aria-label="讀取分享的行事曆" checked={access.shared} onChange={(event) => onChange({ ...access, shared: event.target.checked })} />
						</Row>
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
	const [overlay, setOverlay] = useState<boolean>();
	const [error, setError] = useState("");
	useEffect(() => runtime.triggers.subscribe(setState), [runtime]);
	useEffect(() => runtime.subscribeBots(setBots), [runtime]);
	useEffect(() => {
		if (!native.has("Triggers")) return;
		const refresh = () =>
			void Triggers.status().then((status) => {
				setExact(status.exactAlarms);
				setBluetooth(status.bluetooth);
				setOverlay(status.overlay);
			});
		refresh();
		const listener = App.addListener("resume", () => {
			refresh();
			void runtime.triggers.sync();
		});
		return () => void listener.then((handle) => handle.remove());
	}, [runtime]);
	if (!native.has("Triggers")) return null;
	const headphones = state.items.some((item) => item.state !== "paused" && (item.when.kind === "headphones" || item.when.kind === "bluetooth"));

	const asks = exact === false || (state.items.length > 0 && overlay === false) || (headphones && bluetooth === false);

	return (
		<>
			{state.items.length === 0 ? (
				<Group title="自動化">
					<Row label="還沒有自動化" hint="跟 Bot 說就會建立" />
				</Group>
			) : (
				<div className="trigger-page">
					<TriggerList triggers={state.items} next={state.next} bots={bots} runtime={runtime} onError={setError} />
				</div>
			)}
			{asks ? (
				<Group title="要開的權限">
					{exact === false ? (
						<Row label="準時執行" hint="沒開會晚幾分鐘">
							<button type="button" className="btn" onClick={() => void Triggers.requestExactAlarms()}>
								開啟
							</button>
						</Row>
					) : null}
					{state.items.length > 0 && overlay === false ? (
						<Row label="滑掉 pi 也照跑" hint="沒開時要點通知才會跑">
							<button type="button" className="btn" onClick={() => void Triggers.requestOverlay()}>
								開啟
							</button>
						</Row>
					) : null}
					{headphones && bluetooth === false ? (
						<Row label="偵測藍牙耳機">
							<button type="button" className="btn" onClick={() => void Triggers.requestBluetooth().then(({ granted }) => setBluetooth(granted), (failure: unknown) => setError(messageOf(failure)))}>
								開啟
							</button>
						</Row>
					) : null}
				</Group>
			) : null}
			{error ? <div className="banner error">{error}</div> : null}
		</>
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
		void Promise.all([Usage.status(), System.assistant(), native.implements(PhoneState.display) ? PhoneState.display() : undefined]).then(([usage, assistant, display]) =>
			setState({ usage: usage.allowed, assistant: assistant.held, ...(display ? { settings: display.canChange } : {}) }),
		),
	);
	if (!state) return null;
	const row = (label: string, hint: string | undefined, on: boolean, open: () => Promise<void>) => (
		<Row label={label} hint={hint}>
			<button type="button" className="btn" onClick={() => void open()}>
				{on ? "管理" : "開啟"}
			</button>
		</Row>
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
		<Row label={label}>
			{on ? (
				<span className="state">已開啟</span>
			) : (
				<button type="button" className="btn" onClick={fix}>
					開啟
				</button>
			)}
		</Row>
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
			<Row label="通知存取權" hint={allowed ? "保留 30 天" : undefined}>
				<button type="button" className="btn" onClick={() => void Notifications.openSettings()}>
					{allowed ? "管理" : "開啟"}
				</button>
			</Row>
			{allowed ? (
				<Row label="清除記錄">
					<button type="button" className="btn" disabled={Boolean(cleared)} onClick={() => void Notifications.clear().then(() => showCleared("已清除"))}>
						{cleared ?? "清除"}
					</button>
				</Row>
			) : null}
		</Group>
	);
}

function PhoneScreenGroup() {
	const [allowed, setAllowed] = useState<boolean>();
	useRefreshOnResume("PhoneScreen", () => void PhoneScreen.status().then((status) => setAllowed(status.allowed)));
	if (allowed === undefined) return null;
	return (
		<Group title="代你操作 App">
			<Row label="無障礙服務" hint={allowed ? undefined : "開關是灰的：到 App 資訊 › ⋮ › 允許受限制的設定"}>
				{allowed ? null : (
					<button type="button" className="btn" onClick={() => void PhoneScreen.openAppInfo()}>
						App 資訊
					</button>
				)}
				<button type="button" className="btn" onClick={() => void PhoneScreen.openSettings()}>
					{allowed ? "管理" : "開啟"}
				</button>
			</Row>
		</Group>
	);
}

function DatabaseGroup() {
	const tables = useLoaded(native.has("Database") ? () => Database.schema().then((schema) => schema.tables) : undefined, []).value;
	const [exportError, setExportError] = useState<string>();
	if (!tables) return null;
	return (
		<Group title="資料庫">
			{tables.length === 0 ? (
				<Row label="還沒有資料表" />
			) : (
				tables.map((table) => (
					<Row key={table.name} label={<code>{table.name}</code>} hint={`${table.rows} 筆`} />
				))
			)}
			<Row label="匯出">
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
			</Row>
			{exportError ? <div className="note error">{exportError}</div> : null}
		</Group>
	);
}

const PHONE_PAGE: readonly NativePlugin[] = ["Calendar", "Notifications", "PhoneScreen", "Usage", "KeepAlive"];

type Page = "models" | "memory" | "accounts" | "services" | "machines" | "phone" | "browser" | "schedules" | "data" | "display";

const firstEntry = (text: string) => {
	const line = text.split("\n").find((candidate) => candidate.trim() && !candidate.startsWith("#")) ?? "";
	return line.startsWith("- ") ? line.slice(2) : line;
};

type IndexRow = { page: Page; icon: ReactNode; label: string; status?: string; marks?: { label: string; on: boolean }[] };

function SettingsIndex({ settings, runtime, onOpen }: { settings: Settings; runtime?: AgentRuntime; onOpen: (page: Page) => void }) {
	const [triggers, setTriggers] = useState<TriggerState>();
	const [memory, setMemory] = useState<string>();
	useEffect(() => runtime?.subscribeMemory({ kind: "global" }, (next) => setMemory(next.text)), [runtime]);
	useEffect(() => runtime?.triggers.subscribe(setTriggers), [runtime]);
	useMcp(runtime);
	const tables = useLoaded(native.has("Database") ? () => Database.schema().then((schema) => schema.tables.length) : undefined, []).value;
	const model = runtime?.models.find((candidate) => candidate.provider === settings.defaultProvider && candidate.id === settings.defaultModelId);
	const servers = runtime?.mcp.servers ?? [];
	const waiting = servers.filter((server) => runtime?.mcp.status(server.id)?.state === "login").length;
	const today = triggers ? (grouped(triggers.items, triggers.next, startOfToday() + DAY).find((group) => group.label === "今天")?.triggers.length ?? 0) : 0;
	const phone = [native.has("Calendar") && "行事曆", native.has("Notifications") && "通知", native.has("PhoneScreen") && "代你操作 App"].filter(Boolean).join("、");
	const groups: { label: string; rows: IndexRow[] }[] = [
		{
			label: "Bot 怎麼想",
			rows: [
				{
					page: "models",
					icon: <ModelIcon />,
					label: "模型",
					status: settings.providers.length === 0 ? "還沒有供應商" : [model ? `預設 ${shortModelName(model.name)}` : "", `${settings.providers.length} 個供應商`].filter(Boolean).join(" · "),
				},
				...(runtime
					? [{ page: "memory" as const, icon: <MemoryIcon size={18} />, label: "全域記憶", status: memory ? firstEntry(memory) : "還沒有" }]
					: []),
			],
		},
		{
			label: "Bot 能用什麼",
			rows: [
				{
					page: "accounts",
					icon: <KeyIcon />,
					label: "帳號",
					marks: [
						{ label: "GH", on: Boolean(settings.githubToken) },
						{ label: "GC", on: Boolean(settings.gcloudCredential) },
						{ label: "CF", on: Boolean(settings.cloudflareCredential) },
						{ label: "AZ", on: Boolean(settings.azureCredential) },
					],
				},
				{
					page: "services",
					icon: <PlugIcon />,
					label: "連接的服務",
					status: servers.length === 0 ? "還沒有" : [`${servers.length - waiting} 個可用`, waiting ? `${waiting} 個待登入` : ""].filter(Boolean).join("、"),
				},
				{ page: "machines", icon: <TerminalIcon size={18} />, label: "電腦", status: settings.hosts.map((host) => host.name).join("、") || "還沒有配對" },
				...(native.has("Browser") ? [{ page: "browser" as const, icon: <GlobeIcon size={18} />, label: "瀏覽器", status: `用 ${SEARCH_ENGINES[settings.searchEngine].name} 搜尋` }] : []),
			],
		},
		{
			label: "這支手機",
			rows: [
				...(PHONE_PAGE.some((plugin) => native.has(plugin)) ? [{ page: "phone" as const, icon: <PhoneIcon />, label: "手機", status: phone || undefined }] : []),
				...(native.has("Triggers")
					? [{ page: "schedules" as const, icon: <AutomationIcon />, label: "自動化", status: !triggers || triggers.items.length === 0 ? "還沒有" : today ? `今天還有 ${today} 個` : `${triggers.items.length} 個` }]
					: []),
				...(native.has("Database") ? [{ page: "data" as const, icon: <DatabaseIcon />, label: "資料庫", status: tables === undefined ? undefined : tables ? `${tables} 個資料表` : "還沒有資料表" }] : []),
				{ page: "display", icon: <EyeIcon />, label: "顯示" },
			],
		},
	];
	return (
		<nav className="settings-index">
			{groups.map((group) => (
				<section key={group.label} className="row-list">
					<h3 className="list-label">{group.label}</h3>
					{group.rows.map((row) => (
						<button type="button" key={row.page} onClick={() => onOpen(row.page)}>
							{row.icon}
							<span className="menu-text">
								{row.label}
								{row.status ? <span className="index-status">{row.status}</span> : null}
							</span>
							{row.marks ? (
								<span className="index-marks">
									{row.marks.map((mark) => (
										<span key={mark.label} className={mark.on ? "on" : ""}>
											{mark.label}
										</span>
									))}
								</span>
							) : null}
						</button>
					))}
				</section>
			))}
		</nav>
	);
}

type TextSetting = { [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings];

function UpdateLink({ update }: { update: Update | undefined }) {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	if (!update) return null;
	const install = () => {
		setBusy(true);
		setProblem("");
		void installUpdate(update)
			.catch((error: unknown) => setProblem(messageOf(error)))
			.finally(() => setBusy(false));
	};
	return (
		<>
			{" · "}
			<button type="button" className="link" disabled={busy} onClick={install}>
				{busy ? `下載 ${update.version} 中…` : problem || `更新到 ${update.version}`}
			</button>
		</>
	);
}

type SettingsMode =
	| { mode: "setup"; status?: string; onSave: (settings: Settings) => Promise<void> }
	| { mode: "app"; runtime: AgentRuntime; onDraft: (settings: Settings, changed: boolean) => void; onCancel: () => void };

export function SettingsView(props: { initial: Settings; prefs: Prefs; onPrefs: (change: Partial<Prefs>) => void } & SettingsMode) {
	const { initial, prefs, onPrefs } = props;
	const runtime = props.mode === "app" ? props.runtime : undefined;
	const onDraft = props.mode === "app" ? props.onDraft : undefined;
	const [saving, setSaving] = useState(false);
	const [settings, setSettings] = useState(initial);
	const { value: update } = useLoaded(inApp && native.implements(System.installUpdate) ? () => orLogged(checkForUpdate(), "update.check_failed", undefined) : undefined, []);
	const changed = changedKeys(initial, settings).length > 0;
	const field = (key: TextSetting) => ({
		value: settings[key],
		onChange: (event: { target: { value: string } }) => setSettings({ ...settings, [key]: event.target.value.trim() }),
	});

	useEffect(() => onDraft?.(settings, changed), [settings, changed, onDraft]);
	const [{ page, moved }, setNav] = useState<{ page?: Page; moved?: "in" | "out" }>({});
	const [problem, setProblem] = useState<string>();
	const go = (next: Page | undefined) => {
		setProblem(undefined);
		setNav(next ? { page: next, moved: "in" } : { moved: "out" });
	};
	useBack(page !== undefined, () => go(undefined));
	const change = (next: Partial<Settings>) => setSettings((current) => ({ ...current, ...next }));

	const models = (
		<>
			<ProvidersGroup settings={settings} models={runtime?.models ?? []} onChange={change} />
			{props.mode === "app" ? (
				<section className="row-list">
					<h3 className="list-label">上下文</h3>
					<ChoiceRow
						label="自動壓縮"
						value={String(settings.compactAt)}
						choices={[
							{ value: "64000", label: "64k" },
							{ value: "128000", label: "128k" },
							{ value: "256000", label: "256k（建議）" },
							{ value: "512000", label: "512k" },
							{ value: "0", label: "模型上限" },
						]}
						onChoose={(value) => change({ compactAt: Number(value) })}
					/>
				</section>
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
			body: () =>
				runtime ? <McpGroup runtime={runtime} onError={setProblem} /> : null,
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
		display: {
			title: "顯示",
			body: () => (
				<Group title="對話">
					<Row label="顯示思考過程">
						<input type="checkbox" className="switch" aria-label="顯示思考過程" checked={prefs.showThinking} onChange={(event) => onPrefs({ showThinking: event.target.checked })} />
					</Row>
					<Row label="預設展開工具輸出">
						<input type="checkbox" className="switch" aria-label="預設展開工具輸出" checked={prefs.expandTools} onChange={(event) => onPrefs({ expandTools: event.target.checked })} />
					</Row>
				</Group>
			),
		},
		browser: {
			title: "瀏覽器",
			body: () => (
				<Group title="搜尋引擎">
					<Segmented<SearchEngine>
						label="搜尋引擎"
						value={settings.searchEngine}
						options={[
							{ value: "duckduckgo", label: SEARCH_ENGINES.duckduckgo.name },
							{ value: "google", label: SEARCH_ENGINES.google.name },
						]}
						onChange={(searchEngine) => change({ searchEngine })}
					/>
				</Group>
			),
		},
	};

	if (page === "memory" && runtime) {
		return (
			<div className="screen moved-in">
				<MemoryView runtime={runtime} scope={{ kind: "global" }} onClose={() => go(undefined)} onError={setProblem} />
			</div>
		);
	}
	const current = page && page !== "memory" ? pages[page] : undefined;
	return (
		<div className="screen">
			<header className="bar">
				{current ? <BackButton onClick={() => go(undefined)} /> : props.mode === "app" ? <BackButton onClick={props.onCancel} /> : <span className="bar-spacer" />}
				<h1 className="bar-heading">{current?.title ?? "設定"}</h1>
				{props.mode === "app" ? (
					<span className="bar-spacer" />
				) : (
					<button
						type="button"
						className="btn primary"
						disabled={!isConfigured(settings) || saving}
						onClick={() => {
							setSaving(true);
							setProblem(undefined);
							props
								.onSave(settings)
								.catch((error: unknown) => setProblem(`沒有存下來：${messageOf(error)}`))
								.finally(() => setSaving(false));
						}}>
						{saving ? "開始中…" : "開始"}
					</button>
				)}
			</header>
			<form key={page ?? "index"} className={`settings${moved ? ` moved-${moved}` : ""}`} onSubmit={(event) => event.preventDefault()}>
				{props.mode === "app" ? null : (
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
				{props.mode === "setup" && props.status ? <div className="banner error">{props.status}</div> : null}
				{problem ? <div className="banner error">{problem}</div> : null}
				{current ? current.body() : props.mode === "app" ? <SettingsIndex settings={settings} runtime={runtime} onOpen={go} /> : models}
				{current ? null : (
					<p className="about">
						pi mobile · {__BUILD__}
						{inApp ? (
							<>
								<UpdateLink update={update} />
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
