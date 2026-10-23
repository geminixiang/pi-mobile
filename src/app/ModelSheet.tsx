import { useState } from "react";
import type { ModelInfo } from "../agent/models.ts";
import { CheckIcon, SearchIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";
import { formatTokens } from "./usage.ts";

const THINKING_LEVELS = [
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

/** What a model can do, in a line: its context window, and vision and thinking when it has them. */
function traits(model: ModelInfo): string {
	return [`${formatTokens(model.ownWindow)} context`, model.vision ? "看圖" : "", model.reasoning ? "思考" : ""].filter(Boolean).join(" · ");
}

/** Models shown before 顯示全部: those a catalog knows from custom endpoints, and every model of built-in providers. */
const FIRST_SHOWN = 12;

export function ModelSheet({
	open,
	models,
	current,
	thinking,
	onChange,
	onClose,
}: {
	open: boolean;
	models: ModelInfo[];
	current: { provider: string; id: string };
	thinking: string;
	onChange: (change: { model?: { provider: string; id: string }; thinking?: string }) => void;
	onClose: () => void;
}) {
	const [filter, setFilter] = useState("");
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const query = filter.toLowerCase();
	const matches = models.filter((model) => `${model.id} ${model.name} ${model.providerName}`.toLowerCase().includes(query));
	const providers = [...new Map(matches.map((model) => [model.provider, model.providerName])).entries()];
	const isCurrent = (model: ModelInfo) => model.provider === current.provider && model.id === current.id;

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
				<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜尋模型或供應商" autoCapitalize="off" />
			</label>
			{providers.map(([provider, name]) => {
				const list = matches.filter((model) => model.provider === provider);
				// A long list (a gateway's, OpenRouter's) shows its known models first, and the current one.
				const preferred = list.filter((model) => model.known || isCurrent(model));
				const short = (preferred.length > 0 ? preferred : list).slice(0, FIRST_SHOWN);
				const all = Boolean(filter) || expanded.has(provider) || list.length <= FIRST_SHOWN;
				const visible = all ? list : short.some(isCurrent) || !list.some(isCurrent) ? short : [...short, ...list.filter(isCurrent)];
				return (
					<section key={provider} className="model-group">
						<div className="strip-label">{name}</div>
						<div className="menu model-list">
							{visible.map((model) => (
								<button
									type="button"
									key={model.id}
									className={isCurrent(model) ? "selected" : ""}
									onClick={() => onChange({ model: { provider: model.provider, id: model.id } })}
								>
									<span className={`swatch ${family(model.id)}`} />
									<span className="menu-text">
										{model.name}
										<span className="model-id">{model.known ? traits(model) : model.id}</span>
									</span>
									{isCurrent(model) ? <CheckIcon size={16} /> : null}
								</button>
							))}
							{all ? null : (
								<button type="button" className="more" onClick={() => setExpanded(new Set([...expanded, provider]))}>
									顯示全部 {list.length} 個模型
								</button>
							)}
						</div>
					</section>
				);
			})}
		</Sheet>
	);
}
