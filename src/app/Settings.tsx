import { App } from "@capacitor/app";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { KeepAlive, native } from "./keepAlive.ts";
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
import { registerPlugin } from "@capacitor/core";
import { type AzureDeviceSignIn, describeAzure, finishAzureSignIn, startAzureSignIn } from "../agent/azure.ts";
import { apiTokenCredential, type DeviceSignIn, describeCloudflare, finishDeviceSignIn, startDeviceSignIn } from "../agent/cloudflare.ts";
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

const System = registerPlugin<{ openExternal(options: { url: string }): Promise<void>; clipboardText(): Promise<{ text: string }> }>(
	"System",
);

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
				<BackgroundGroup />
				<p className="about">pi mobile · {__BUILD__}</p>
			</form>
		</div>
	);
}
