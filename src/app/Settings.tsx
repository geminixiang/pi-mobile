import { type ReactNode, useState } from "react";
import { checkGitHub, checkModels, checkSandbox } from "../agent/checks.ts";
import type { Settings } from "../settings.ts";
import { BackIcon } from "./icons.tsx";

type Check = { state: "idle" } | { state: "checking" } | { state: "ok"; detail: string } | { state: "error"; detail: string };

function CheckButton({ run, disabled }: { run: () => Promise<string>; disabled: boolean }) {
	const [check, setCheck] = useState<Check>({ state: "idle" });
	return (
		<div className="check">
			<button
				type="button"
				className="link"
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
			{check.state === "ok" ? <span className="check-ok">● {check.detail}</span> : null}
			{check.state === "error" ? <span className="check-error">● {check.detail}</span> : null}
		</div>
	);
}

function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<section className="group">
			<h2>{title}</h2>
			<div className="group-body">{children}</div>
			{hint ? <p className="hint">{hint}</p> : null}
		</section>
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
				<h1 className="bar-title">設定</h1>
				<button type="button" className="pill accent" disabled={!settings.baseUrl || !settings.apiKey} onClick={() => onSave(settings)}>
					儲存
				</button>
			</header>
			{status ? <div className="note error padded">{status}</div> : null}
			<form className="settings" onSubmit={(event) => event.preventDefault()}>
				<Group title="模型服務" hint="CLIProxyAPI 的位址和 key。key 存在手機的 Keystore。">
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

				<Group title="Sandbox" hint="每個對話有自己的 Linux 容器，模型可以用 read、write、edit、bash。留空就不啟用。">
					<label>
						<span>Relay</span>
						<input {...field("sandboxUrl")} placeholder="ws://100.x.y.z:8787" autoCapitalize="off" autoComplete="off" inputMode="url" />
					</label>
					<label>
						<span>Token</span>
						<input {...field("sandboxToken")} type="password" autoComplete="off" />
					</label>
					<CheckButton disabled={!settings.sandboxUrl || !settings.sandboxToken} run={() => checkSandbox(settings.sandboxUrl, settings.sandboxToken)} />
				</Group>
			</form>
		</div>
	);
}
