// The cloud sign-ins in Settings › 帳號: Google's consent page with a code to copy back, and the device code flow that
// Cloudflare and Microsoft use.
import { App } from "@capacitor/app";
import { useEffect, useRef, useState } from "react";
import type { DeviceSignIn } from "../agent/oauth.ts";
import { finishGoogleSignIn, type GoogleSignIn, looksLikeAuthCode, startGoogleSignIn } from "../agent/gcloud.ts";
import { System } from "../system-plugin.ts";

/**
 * Sign in with Google: opens Google's consent page in the browser; its last page shows an authorization code. When the
 * user copies it and comes back, the app finds it on the clipboard; pasting by hand works too.
 */
export function GoogleSignInPanel({ onCredential }: { onCredential: (json: string) => void }) {
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

/**
 * A device code flow: show the code, open the provider's page, and poll until the user approves it there. With
 * copyCode the code is on the clipboard too, for a page that asks for it (Microsoft's).
 */
export function DeviceSignInPanel({
	provider,
	start,
	finish,
	copyCode = false,
	onCredential,
}: {
	provider: string;
	start: () => Promise<DeviceSignIn>;
	finish: (signIn: DeviceSignIn, signal: AbortSignal) => Promise<string>;
	copyCode?: boolean;
	onCredential: (json: string) => void;
}) {
	const [signIn, setSignIn] = useState<DeviceSignIn>();
	const [error, setError] = useState("");
	const abort = useRef<AbortController>(undefined);
	useEffect(() => () => abort.current?.abort(), []);

	const begin = async () => {
		setError("");
		try {
			const next = await start();
			setSignIn(next);
			if (copyCode) await navigator.clipboard.writeText(next.userCode).catch(() => undefined);
			const controller = new AbortController();
			abort.current = controller;
			await System.openExternal({ url: next.url });
			onCredential(await finish(next, controller.signal));
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
					<span className="menu-text">用 {provider} 帳號登入</span>
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
			<p>{copyCode ? `代碼已複製，在 ${provider} 的頁面貼上：` : `在 ${provider} 頁面確認這組代碼：`}</p>
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
