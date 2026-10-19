import { useState } from "react";
import type { ModelInfo } from "../agent/models.ts";
import { Sheet } from "./Sheet.tsx";

export const THINKING_LEVELS = [
	["off", "關"],
	["low", "低"],
	["medium", "中"],
	["high", "高"],
	["xhigh", "極高"],
] as const;

/** Thinking level as 0–4 filled bars, for the header pill. */
export function ThinkingBars({ level }: { level: string }) {
	const filled = Math.max(0, THINKING_LEVELS.findIndex(([value]) => value === level));
	return (
		<span className="bars" aria-label={`思考強度 ${level}`}>
			{[1, 2, 3, 4].map((bar) => (
				<i key={bar} className={bar <= filled ? "on" : ""} />
			))}
		</span>
	);
}

export function ModelSheet({
	models,
	modelId,
	thinking,
	onChange,
	onClose,
}: {
	models: ModelInfo[];
	modelId: string;
	thinking: string;
	onChange: (change: { modelId?: string; thinking?: string }) => void;
	onClose: () => void;
}) {
	const [filter, setFilter] = useState("");
	const [showAll, setShowAll] = useState(false);
	const matches = models.filter((model) => `${model.id} ${model.name}`.toLowerCase().includes(filter.toLowerCase()));
	const visible = showAll || filter ? matches : matches.filter((model) => model.known);

	return (
		<Sheet onClose={onClose} title="模型">
			<div className="segmented" role="radiogroup" aria-label="思考強度">
				{THINKING_LEVELS.map(([level, label]) => (
					<button
						type="button"
						role="radio"
						aria-checked={level === thinking}
						key={level}
						className={level === thinking ? "selected" : ""}
						onClick={() => onChange({ thinking: level })}
					>
						{label}
					</button>
				))}
			</div>
			<input className="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜尋模型" autoCapitalize="off" />
			<div className="model-list">
				{visible.map((model) => (
					<button
						type="button"
						key={model.id}
						className={model.id === modelId ? "selected" : ""}
						onClick={() => onChange({ modelId: model.id })}
					>
						<span className="model-name">{model.name}</span>
						<span className="model-id">{model.id}</span>
					</button>
				))}
				{!showAll && !filter ? (
					<button type="button" className="more" onClick={() => setShowAll(true)}>
						顯示全部 {models.length} 個模型
					</button>
				) : null}
			</div>
		</Sheet>
	);
}
