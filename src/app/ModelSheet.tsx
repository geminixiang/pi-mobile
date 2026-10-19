import { useState } from "react";
import type { ModelInfo } from "../agent/models.ts";
import { CheckIcon, SearchIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";

export const THINKING_LEVELS = [
	["off", "關"],
	["low", "低"],
	["medium", "中"],
	["high", "高"],
	["xhigh", "極高"],
] as const;

export function thinkingLabel(level: string): string {
	return THINKING_LEVELS.find(([value]) => value === level)?.[1] ?? level;
}

/** Model family, for the small swatch next to each model. */
function family(id: string): string {
	const lower = id.toLowerCase();
	if (lower.includes("claude")) return "claude";
	if (lower.startsWith("gpt") || /^o\d/.test(lower)) return "gpt";
	if (lower.includes("gemini")) return "gemini";
	return "other";
}

/** Model name without the vendor prefix, for the narrow header. */
export function shortModelName(name: string): string {
	return name.replace(/^Claude /, "");
}

export function ModelSheet({
	open,
	models,
	modelId,
	thinking,
	onChange,
	onClose,
}: {
	open: boolean;
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
		<Sheet open={open} onClose={onClose} title="模型">
			<div className="strip-label">思考強度</div>
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
			<label className="field-icon">
				<SearchIcon />
				<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜尋模型" autoCapitalize="off" />
			</label>
			<div className="menu model-list">
				{visible.map((model) => (
					<button
						type="button"
						key={model.id}
						className={model.id === modelId ? "selected" : ""}
						onClick={() => onChange({ modelId: model.id })}
					>
						<span className={`swatch ${family(model.id)}`} />
						<span className="menu-text">
							{model.name}
							<span className="model-id">{model.id}</span>
						</span>
						{model.id === modelId ? <CheckIcon size={16} /> : null}
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
