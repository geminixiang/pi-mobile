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
import { phonePermissions } from "../interaction/phone-permissions.ts";
import type { Bot } from "../agent/bots.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { TriggerState } from "../triggers/runs.ts";
import { Triggers } from "../triggers/plugin.ts";
import { changedKeys, isConfigured, SEARCH_ENGINES, type SearchEngine, type Settings } from "../settings.ts";
import { AutomationIcon, AzureMark, CloudflareMark, DatabaseIcon, GitHubMark, GoogleCloudMark, EyeIcon, GlobeIcon, KeyIcon, MemoryIcon, ModelIcon, PhoneIcon, PlugIcon, TerminalIcon } from "./icons.tsx";
import { BackButton } from "./BackButton.tsx";
import { PageStack } from "./PageStack.tsx";
import { pairedHosts } from "../agent/sandbox/host.ts";
import { HostsGroup } from "./HostsGroup.tsx";
import { CheckButton } from "./CheckButton.tsx";
import { RowList } from "./RowList.tsx";
import { ProvidersGroup } from "./ProvidersGroup.tsx";
import { ChoiceRow } from "./ChoiceRow.tsx";
import { Sheet } from "./Sheet.tsx";
import { McpGroup, useMcp } from "./McpGroup.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { PiMark } from "./PiMark.tsx";
import { TriggerList } from "../triggers/TriggerList.tsx";
import { grouped } from "../triggers/when.ts";
import { DAY, startOfToday } from "../agent/tools/common.ts";
import { shortModelName } from "./ModelSheet.tsx";
import { useLoaded } from "./loaded.ts";
import { messageOf, orLogged } from "../promise.ts";
import { checkForUpdate, installUpdate, type Update } from "./update.ts";
import type { Prefs } from "./prefs.ts";

type Account = "github" | "gcloud" | "cloudflare" | "azure";

function AccountsPage({ settings, change }: { settings: Settings; change: (next: Partial<Settings>) => void }) {
	const [open, setOpen] = useState<Account>();
	const accounts: { id: Account; name: string; mark: ReactNode; signedIn: string }[] = [
		{ id: "github", name: "GitHub", mark: <GitHubMark />, signedIn: settings.githubToken ? "已填 token" : "" },
		{ id: "gcloud", name: "Google Cloud", mark: <GoogleCloudMark />, signedIn: settings.gcloudCredential ? describeGcloud(settings.gcloudCredential) : "" },
		{ id: "cloudflare", name: "Cloudflare", mark: <CloudflareMark />, signedIn: settings.cloudflareCredential ? describeCloudflare(settings.cloudflareCredential) : "" },
		{ id: "azure", name: "Azure", mark: <AzureMark />, signedIn: settings.azureCredential ? describeAzure(settings.azureCredential) : "" },
	];
	const shown = accounts.find((account) => account.id === open);
	const remove: Record<Account, Partial<Settings>> = {
		github: { githubToken: "" },
		gcloud: { gcloudCredential: "", gcloudProject: "" },
		cloudflare: { cloudflareCredential: "" },
		azure: { azureCredential: "" },
	};
	return (
		<>
			<RowList title="Bot 用你的身分登入">
				{accounts.map((account) => (
					<button type="button" key={account.id} onClick={() => setOpen(account.id)}>
						{account.mark}
						<span className="menu-text">
							{account.name}
							<span className="index-status">{account.signedIn || "還沒登入"}</span>
						</span>
						<i className={`row-dot${account.signedIn ? "" : " off"}`} />
					</button>
				))}
			</RowList>
			<Sheet open={shown !== undefined} title={shown?.name ?? ""} onClose={() => setOpen(undefined)}>
				{shown ? (
					<div className="sheet-form">
						{shown.id === "github" ? (
							<>
								<label>
									<span>Token</span>
									<input
										value={settings.githubToken}
										onChange={(event) => change({ githubToken: event.target.value.trim() })}
										type="password"
										autoComplete="off"
										placeholder="github_pat_…"
									/>
								</label>
								<CheckButton disabled={!settings.githubToken} run={() => checkGitHub(settings.githubToken)} />
							</>
						) : null}
						{shown.id === "gcloud" ? (
							<>
								{settings.gcloudCredential ? null : (
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
									<input
										value={settings.gcloudProject}
										onChange={(event) => change({ gcloudProject: event.target.value.trim() })}
										placeholder="憑證本身的專案"
										autoCapitalize="off"
										autoComplete="off"
									/>
								</label>
								<CheckButton disabled={!settings.gcloudCredential} run={() => checkGcloud(settings.gcloudCredential)} />
							</>
						) : null}
						{shown.id === "cloudflare" ? (
							settings.cloudflareCredential ? null : (
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
							)
						) : null}
						{shown.id === "azure" ? (
							settings.azureCredential ? null : (
								<DeviceSignInPanel provider="Microsoft" start={startAzureSignIn} finish={finishAzureSignIn} copyCode onCredential={(json) => change({ azureCredential: json })} />
							)
						) : null}
						{shown.signedIn ? (
							<button
								type="button"
								className="danger-verb"
								onClick={() => {
									setOpen(undefined);
									change(remove[shown.id]);
								}}
							>
								移除
							</button>
						) : null}
					</div>
				) : null}
			</Sheet>
		</>
	);
}

function CalendarGroup({ access, onChange }: { access: CalendarAccess; onChange: (access: CalendarAccess) => void }) {
	const [calendars, setCalendars] = useState<PhoneCalendar[]>();
	const [error, setError] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const load = () =>
		Calendar.listAccounts().then(
			({ calendars }) => setCalendars(calendars),
			(failure: unknown) => setError(messageOf(failure)),
		);
	const askThenLoad = () =>
		phonePermissions.request("calendar").then(
			(allowed) => (allowed ? load() : setError("沒有行事曆權限，到手機設定開啟")),
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
		return (
			<ChoiceRow<Use>
				key={group.key}
				label={group.label}
				hint={group.calendars.some((calendar) => !group.label.startsWith(calendar.name)) ? group.calendars.map((calendar) => calendar.name).join("、") : undefined}
				value={!readable ? "off" : access.writable.includes(group.key) ? "write" : "read"}
				choices={[
					{ value: "off", label: "不用" },
					{ value: "read", label: "只讀" },
					{ value: "write", label: "讀寫", disabled: !group.calendars.some((calendar) => calendar.writable) },
				]}
				onChoose={(use) => choose(group, use)}
			/>
		);
	};

	return (
		<RowList title="行事曆">
			{calendars === undefined ? (
				<button type="button" onClick={() => void askThenLoad()}>
					<span className="menu-text">
						讀取帳號清單
						{error ? <span className="index-status error">{error}</span> : null}
					</span>
				</button>
			) : (
				<>
					{groups.filter((group) => !access.hidden.includes(group.key)).map(accountRow)}
					{hiddenGroups.length > 0 && !showHidden ? (
						<button type="button" onClick={() => setShowHidden(true)}>
							<span className="menu-text">其他 {hiddenGroups.length} 個帳號</span>
							<span className="row-value">不用</span>
						</button>
					) : null}
					{showHidden ? hiddenGroups.map(accountRow) : null}
					{sharedCount > 0 ? (
						<ChoiceRow
							label={`${sharedCount} 個分享的行事曆`}
							value={access.shared ? "read" : "off"}
							choices={[
								{ value: "off", label: "不用" },
								{ value: "read", label: "只讀" },
							]}
							onChoose={(use) => onChange({ ...access, shared: use === "read" })}
						/>
					) : null}
					{writableTargets.length > 0 ? (
						<ChoiceRow
							label="新行程寫到"
							value={String(access.defaultCalendar ?? "")}
							shown={writableTargets.find((calendar) => calendar.id === access.defaultCalendar)?.name}
							choices={[
								{ value: "", label: "每次問我" },
								...writableTargets.map((calendar) => ({
									value: String(calendar.id),
									label: calendar.name === calendar.account ? calendar.account : `${calendar.name} · ${calendar.account}`,
								})),
							]}
							onChoose={(id) => onChange({ ...access, defaultCalendar: id ? Number(id) : undefined })}
						/>
					) : null}
				</>
			)}
		</RowList>
	);
}

function TriggersGroup({ runtime }: { runtime: AgentRuntime }) {
	const [state, setState] = useState<TriggerState>({ items: [], next: {} });
	const [bots, setBots] = useState<Bot[]>([]);
	const [bluetooth, setBluetooth] = useState<boolean>();
	const [overlay, setOverlay] = useState<boolean>();
	const [error, setError] = useState("");
	useEffect(() => runtime.triggers.subscribe(setState), [runtime]);
	useEffect(() => runtime.subscribeBots(setBots), [runtime]);
	useEffect(() => {
		if (!native.has("Triggers")) return;
		const refresh = () =>
			void Triggers.status().then((status) => {
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

	const asks = (state.items.length > 0 && overlay === false) || (headphones && bluetooth === false);

	return (
		<>
			{state.items.length === 0 ? (
				<RowList title="自動化">
					<p className="row-empty">還沒有自動化，跟 Bot 說就會建立</p>
				</RowList>
			) : (
				<div className="trigger-page">
					<TriggerList triggers={state.items} next={state.next} bots={bots} runtime={runtime} onError={setError} />
				</div>
			)}
			{asks ? (
				<RowList title="要開的權限">
					{state.items.length > 0 && overlay === false ? <StateRow label="滑掉 pi 也照跑" hint="沒開時要點通知才會跑" on={false} onClick={() => void Triggers.requestOverlay()} /> : null}
					{headphones && bluetooth === false ? (
						<StateRow
							label="偵測藍牙耳機"
							on={false}
							onClick={() => void Triggers.requestBluetooth().then(({ granted }) => setBluetooth(granted), (failure: unknown) => setError(messageOf(failure)))}
						/>
					) : null}
				</RowList>
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

function StateRow({ label, hint, on, onClick }: { label: string; hint?: string; on: boolean; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick}>
			<span className="menu-text">
				{label}
				{hint ? <span className="index-status">{hint}</span> : null}
			</span>
			<i className={`row-dot${on ? "" : " off"}`} aria-label={on ? "已開啟" : "未開啟"} />
		</button>
	);
}

function SystemAccessGroup() {
	const [state, setState] = useState<{ usage: boolean; assistant: boolean; settings?: boolean }>();
	useRefreshOnResume("Usage", () =>
		void Promise.all([Usage.status(), System.assistant(), native.implements(PhoneState.display) ? PhoneState.display() : undefined]).then(([usage, assistant, display]) =>
			setState({ usage: usage.allowed, assistant: assistant.held, ...(display ? { settings: display.canChange } : {}) }),
		),
	);
	if (!state) return null;
	return (
		<RowList title="系統權限">
			<StateRow label="螢幕使用時間" hint={state.usage ? undefined : "讓 Bot 看每個 app 用了多久"} on={state.usage} onClick={() => void Usage.openSettings()} />
			{state.settings === undefined ? null : (
				<StateRow label="修改系統設定" hint={state.settings ? undefined : "讓 Bot 調亮度、自動旋轉、螢幕關閉時間"} on={state.settings} onClick={() => void PhoneState.openWriteSettings()} />
			)}
			<StateRow
				label="數位助理"
				hint={state.assistant ? "長按側邊鍵叫出 pi，帶著目前的畫面" : "設成數位助理，就能在任何畫面叫出 pi"}
				on={state.assistant}
				onClick={() => void System.openAssistantSettings()}
			/>
		</RowList>
	);
}

function BackgroundGroup() {
	const [status, setStatus] = useState<{ notifications: boolean; unrestrictedBattery?: boolean }>();
	useRefreshOnResume("KeepAlive", () => void KeepAlive.status().then(setStatus));
	if (!status) return null;
	return (
		<RowList title="背景執行">
			<StateRow label="通知" on={status.notifications} onClick={() => void KeepAlive.requestNotifications().then(() => KeepAlive.status().then(setStatus))} />
			{status.unrestrictedBattery === undefined ? null : (
				<StateRow label="不受電池最佳化限制" on={status.unrestrictedBattery} onClick={() => void KeepAlive.requestUnrestrictedBattery()} />
			)}
		</RowList>
	);
}

function NotificationsGroup({ allowed }: { allowed: boolean | undefined }) {
	if (allowed === undefined) return null;
	return (
		<RowList title="通知">
			<StateRow label="讀取通知" hint={allowed ? "保留 30 天" : "讓 Bot 看到收到的通知"} on={allowed} onClick={() => void Notifications.openSettings()} />
		</RowList>
	);
}

function ClearNotifications() {
	const [cleared, showCleared] = useBriefly();
	return (
		<button type="button" className="danger-verb" disabled={Boolean(cleared)} onClick={() => void Notifications.clear().then(() => showCleared("已清除"))}>
			{cleared ?? "清除通知紀錄"}
		</button>
	);
}

function PhoneScreenGroup() {
	const [allowed, setAllowed] = useState<boolean>();
	useRefreshOnResume("PhoneScreen", () => void PhoneScreen.status().then((status) => setAllowed(status.allowed)));
	if (allowed === undefined) return null;
	return (
		<RowList title="代你操作 App">
			<StateRow label="無障礙服務" hint={allowed ? "背景時也能開 App" : "開關是灰的：到 App 資訊 › ⋮ › 允許受限制的設定"} on={allowed} onClick={() => void PhoneScreen.openSettings()} />
			{allowed ? null : (
				<button type="button" className="row-add" onClick={() => void PhoneScreen.openAppInfo()}>
					打開 App 資訊
				</button>
			)}
		</RowList>
	);
}

function PhonePage({ access, onChange }: { access: CalendarAccess; onChange: (access: CalendarAccess) => void }) {
	const [notifications, setNotifications] = useState<boolean>();
	useRefreshOnResume("Notifications", () => void Notifications.status().then((status) => setNotifications(status.allowed)));
	return (
		<>
			<CalendarGroup access={access} onChange={onChange} />
			<NotificationsGroup allowed={notifications} />
			<PhoneScreenGroup />
			<SystemAccessGroup />
			<BackgroundGroup />
			{notifications ? <ClearNotifications /> : null}
		</>
	);
}

function DatabaseGroup() {
	const tables = useLoaded(native.has("Database") ? () => Database.schema().then((schema) => schema.tables) : undefined, []).value;
	const [exportError, setExportError] = useState<string>();
	if (!tables) return null;
	return (
		<RowList title="資料表">
			{tables.length === 0 ? (
				<p className="row-empty">還沒有資料表</p>
			) : (
				tables.map((table) => (
					<div className="row-static" key={table.name}>
						<code className="menu-text">{table.name}</code>
						<span className="row-count">{table.rows} 筆</span>
					</div>
				))
			)}
			<div className="inline-verbs">
				<button
					type="button"
					onClick={() => {
						setExportError(undefined);
						void Database.export().catch((error: unknown) => setExportError(`匯出失敗：${messageOf(error)}`));
					}}
				>
					匯出
				</button>
			</div>
			{exportError ? <p className="row-empty error">{exportError}</p> : null}
		</RowList>
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
				<RowList key={group.label} title={group.label}>
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
				</RowList>
			))}
		</nav>
	);
}

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

	useEffect(() => onDraft?.(settings, changed), [settings, changed, onDraft]);
	const [page, setPage] = useState<Page>();
	const [problem, setProblem] = useState<string>();
	const go = (next: Page | undefined) => {
		setProblem(undefined);
		setPage(next);
	};
	const change = (next: Partial<Settings>) => setSettings((current) => ({ ...current, ...next }));

	const models = (
		<>
			<ProvidersGroup settings={settings} models={runtime?.models ?? []} onChange={change} />
			{props.mode === "app" ? (
				<RowList title="上下文">
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
				</RowList>
			) : null}
		</>
	);

	const pages: Record<Exclude<Page, "memory">, { title: string; body: () => ReactNode }> = {
		models: { title: "模型", body: () => models },
		accounts: {
			title: "帳號",
			body: () => <AccountsPage settings={settings} change={change} />,
		},
		services: {
			title: "連接的服務",
			body: () =>
				runtime ? <McpGroup runtime={runtime} onError={setProblem} /> : null,
		},
		machines: {
			title: "電腦",
			body: () => (
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
			),
		},
		phone: {
			title: "手機",
			body: () => (
				<PhonePage access={settings.calendarAccess} onChange={(calendarAccess) => change({ calendarAccess })} />
			),
		},
		schedules: { title: "自動化", body: () => (runtime ? <TriggersGroup runtime={runtime} /> : null) },
		data: { title: "資料庫", body: () => <DatabaseGroup /> },
		display: {
			title: "顯示",
			body: () => (
				<RowList title="對話">
					<label>
						<span className="menu-text">顯示思考過程</span>
						<input type="checkbox" className="switch" checked={prefs.showThinking} onChange={(event) => onPrefs({ showThinking: event.target.checked })} />
					</label>
					<label>
						<span className="menu-text">預設展開工具輸出</span>
						<input type="checkbox" className="switch" checked={prefs.expandTools} onChange={(event) => onPrefs({ expandTools: event.target.checked })} />
					</label>
				</RowList>
			),
		},
		browser: {
			title: "瀏覽器",
			body: () => (
				<RowList title="搜尋">
					<ChoiceRow<SearchEngine>
						label="搜尋引擎"
						value={settings.searchEngine}
						choices={[
							{ value: "duckduckgo", label: SEARCH_ENGINES.duckduckgo.name },
							{ value: "google", label: SEARCH_ENGINES.google.name },
						]}
						onChoose={(searchEngine) => change({ searchEngine })}
					/>
				</RowList>
			),
		},
	};

	const banner = problem ? <div className="banner error">{problem}</div> : null;
	const back = () => go(undefined);
	const top = (opened: Page) =>
		opened === "memory" ? (
			runtime ? <MemoryView runtime={runtime} scope={{ kind: "global" }} onClose={back} onError={setProblem} /> : null
		) : (
			<div className="screen">
				<header className="bar">
					<BackButton onClick={back} />
					<h1 className="bar-heading">{pages[opened].title}</h1>
					<span className="bar-spacer" />
				</header>
				<form className="settings" onSubmit={(event) => event.preventDefault()}>
					{banner}
					{pages[opened].body()}
				</form>
			</div>
		);
	return (
		<PageStack side="left" top={page ? { key: page, content: top(page), onBack: back } : undefined}>
			<div className="screen">
				<header className="bar">
					{props.mode === "app" ? <BackButton onClick={props.onCancel} /> : <span className="bar-spacer" />}
					<h1 className="bar-heading">設定</h1>
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
				<form className="settings" onSubmit={(event) => event.preventDefault()}>
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
					{page ? null : banner}
					{props.mode === "app" ? <SettingsIndex settings={settings} runtime={runtime} onOpen={go} /> : models}
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
				</form>
			</div>
		</PageStack>
	);
}
