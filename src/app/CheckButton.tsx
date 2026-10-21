// 測試連線: runs a settings check and shows what it reached or why it failed.
import { useState } from "react";

type Check = { state: "idle" } | { state: "checking" } | { state: "ok"; detail: string } | { state: "error"; detail: string };

export function CheckButton({ run, disabled }: { run: () => Promise<string>; disabled: boolean }) {
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
