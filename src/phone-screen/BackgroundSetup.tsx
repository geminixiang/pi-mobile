import { useState } from "react";
import { messageOf } from "../promise.ts";
import { useOnResume } from "../ui/resume.ts";
import { backgroundSetup, type SetupStatus } from "./background.ts";

const CODE = /^\d{6}$/;

const STATE: Record<string, string> = { developer_off: "未設定", not_paired: "未設定", debugging_off: "無線偵錯沒開" };

const GUIDE: Record<string, string> = {
	developer_off: "連按七次「版本號碼」打開開發人員選項，再到無線偵錯，點用配對碼配對裝置；pi 會自己配對",
	not_paired: "開啟無線偵錯，點用配對碼配對裝置；pi 會自己配對",
	debugging_off: "開啟無線偵錯",
};

const QUIET = new Set(["left", "restarted"]);

const PROBLEM: Record<string, string> = {
	code_not_found: "讀不到配對碼，請在旁邊輸入",
	accessibility_off: "無障礙服務沒開，讀不到配對碼",
	timeout: "五分鐘內沒看到配對視窗，再按一次",
	pairing_closed: "配對視窗關了，再開一次配對碼",
	wrong_code: "配對碼不對",
	debugging_off: "無線偵錯沒開",
};

type Attempt = { state: "idle" } | { state: "pairing" } | { state: "failed"; problem: string };

const failed = (failure: unknown): SetupStatus => ({ ok: false, reason: messageOf(failure) });

export function BackgroundSetup({ allowed }: { allowed: boolean }) {
	const [status, setStatus] = useState<SetupStatus>();
	const [attempt, setAttempt] = useState<Attempt>({ state: "idle" });
	const refresh = () => backgroundSetup.status().then(setStatus, (failure: unknown) => setStatus(failed(failure)));
	useOnResume(() => void refresh());
	if (!status) return null;
	const settle = (paired: SetupStatus) => {
		if (paired.ok) return void refresh().then(() => setAttempt({ state: "idle" }));
		if (QUIET.has(paired.reason)) return setAttempt({ state: "idle" });
		setAttempt({ state: "failed", problem: PROBLEM[paired.reason] ?? `配對失敗：${paired.reason}` });
	};
	const start = () => {
		setAttempt({ state: "idle" });
		void backgroundSetup.pairInSettings().catch(failed).then(settle);
	};
	const pair = (code: string) => {
		setAttempt({ state: "pairing" });
		void backgroundSetup.pair(code).catch(failed).then(settle);
	};
	const reason = status.ok ? undefined : status.reason;
	const state = reason === undefined ? "可用" : STATE[reason];
	return (
		<>
			<div className="row-static">
				<span className="menu-text">背景操作</span>
				<span className="index-value">{state ?? "連不上"}</span>
			</div>
			{reason === undefined ? null : (
				<>
					{state === undefined ? <p className="row-empty error">{reason}</p> : null}
					{allowed ? null : <p className="row-empty">先開啟上面的無障礙服務，pi 才能自己配對</p>}
					<p className="row-empty">{GUIDE[reason] ?? GUIDE.not_paired}</p>
					<div className="inline-verbs">
						<button type="button" onClick={start}>
							{reason === "developer_off" ? "打開關於手機" : "打開無線偵錯"}
						</button>
						{reason === "debugging_off" ? null : (
							<input
								className="field code-field"
								onChange={(event) => {
									const code = event.target.value.trim();
									if (CODE.test(code)) pair(code);
								}}
								disabled={attempt.state === "pairing"}
								maxLength={6}
								placeholder="或輸入配對碼"
								aria-label="配對碼"
								inputMode="numeric"
								autoComplete="one-time-code"
								enterKeyHint="done"
							/>
						)}
					</div>
					{attempt.state === "pairing" ? <p className="row-empty">配對中…</p> : null}
					{attempt.state === "failed" ? <p className="row-empty error">{attempt.problem}</p> : null}
				</>
			)}
		</>
	);
}
