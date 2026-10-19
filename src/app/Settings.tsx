import { App } from "@capacitor/app";
import { type ReactNode, useEffect, useState } from "react";
import { KeepAlive, native } from "./keepAlive.ts";
import { checkGitHub, checkModels, checkSandbox } from "../agent/checks.ts";
import { checkGcloud, describeCredential, parseCredential } from "../agent/gcloud.ts";
import type { Settings } from "../settings.ts";
import { BackIcon } from "./icons.tsx";
import { PiMark } from "./PiMark.tsx";

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

export function SettingsView({
	initial,
	status,
	onSave,
	onCancel,
}: {
	initial: Settings;
	status?: string;
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

				<Group title="GitHub" hint="建議用 fine-grained token，只開需要的 repository 和權限。寫入前一定會先問你。">
					<label>
						<span>Token</span>
						<input {...field("githubToken")} type="password" autoComplete="off" placeholder="github_pat_…" />
					</label>
					<CheckButton disabled={!settings.githubToken} run={() => checkGitHub(settings.githubToken)} />
				</Group>

				<Group
					title="Sandbox"
					hint="每個對話有自己的 Linux 容器，模型可以用 read、write、edit、bash，git 和 gh 也已登入你的 GitHub。留空就不啟用。"
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
						<label>
							<span>憑證 JSON</span>
							<textarea
								className="field json"
								rows={4}
								value={settings.gcloudCredential}
								onChange={(event) => setSettings({ ...settings, gcloudCredential: event.target.value.trim() })}
								placeholder="貼上 application_default_credentials.json（gcloud auth application-default login 產生）或 service account 金鑰"
								autoCapitalize="off"
								spellCheck={false}
							/>
						</label>
					)}
					<label>
						<span>預設專案</span>
						<input {...field("gcloudProject")} placeholder="留空則用憑證本身的專案" autoCapitalize="off" autoComplete="off" />
					</label>
					<CheckButton disabled={!settings.gcloudCredential} run={() => checkGcloud(settings.gcloudCredential)} />
				</Group>
				<BackgroundGroup />
				<p className="about">pi mobile · {__BUILD__}</p>
			</form>
		</div>
	);
}
