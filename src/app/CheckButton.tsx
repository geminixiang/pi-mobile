// 測試連線: runs a settings check and shows what it reached or why it failed.
import { type ReactNode, useState } from "react";

type Check = { state: "idle" } | { state: "checking" } | { state: "ok"; detail: string } | { state: "error"; detail: string };

/** `children`: more buttons for the same item (移除), at the end of the row. */
export function CheckButton({ run, disabled, children }: { run: () => Promise<string>; disabled: boolean; children?: ReactNode }) {
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
			{children ? <span className="check-more">{children}</span> : null}
		</div>
	);
}
