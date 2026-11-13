import { useState } from "react";
import type { AgentRuntime } from "../agent/runtime.ts";
import { messageOf } from "../promise.ts";
import { DAY, HOUR, startOfToday } from "../time.ts";
import type { Item } from "./items.ts";

const TOMORROW_MORNING = DAY + 9 * HOUR;

export function ItemActions({ runtime, item, onAsk, onDone }: { runtime: AgentRuntime; item: Item; onAsk: (text: string) => void; onDone: () => void }) {
	const [problem, setProblem] = useState<string>();
	const act = (change: Promise<void>) => void change.then(onDone, (error: unknown) => setProblem(messageOf(error)));
	return (
		<>
			<div className="item-actions">
				<button
					type="button"
					className="btn primary"
					onClick={() => {
						onAsk(`我們來處理這件事：${item.title}`);
						onDone();
					}}
				>
					請 Bot 處理
				</button>
				<button type="button" className="btn" onClick={() => act(runtime.triggers.finishItem(item.id))}>
					完成了
				</button>
				<button type="button" className="btn" onClick={() => act(runtime.triggers.postponeItem(item.id, startOfToday() + TOMORROW_MORNING))}>
					明天再說
				</button>
			</div>
			{problem ? <p className="item-problem">{problem}</p> : null}
		</>
	);
}
