import { Component, type ReactNode } from "react";
import { log } from "../log.ts";
import { messageOf } from "../promise.ts";
import { shareDiagnostics } from "./diagnostics.ts";

type CrashState = { failed: false } | { failed: true; message: string };

// why: React catches an error thrown while rendering only in a class component with getDerivedStateFromError
export class Crash extends Component<{ children: ReactNode }, CrashState> {
	override state: CrashState = { failed: false };

	static getDerivedStateFromError(error: unknown): CrashState {
		return { failed: true, message: messageOf(error) };
	}

	override componentDidCatch(error: unknown): void {
		log.error("ui.crash", { error: messageOf(error), stack: error instanceof Error ? (error.stack ?? "") : "" });
	}

	override render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			<main className="crash">
				<h1>畫面出錯了</h1>
				<p>{this.state.message}</p>
				<button type="button" className="btn" onClick={() => location.reload()}>
					重新載入
				</button>
				<button type="button" className="btn" onClick={() => void shareDiagnostics()}>
					分享診斷記錄
				</button>
			</main>
		);
	}
}
