import { useState } from "react";
import { CheckIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";

type Choice<T extends string> = { value: T; label: string; group?: string; disabled?: boolean };

export function ChoiceRow<T extends string>({
	label,
	hint,
	value,
	shown,
	choices,
	onChoose,
}: {
	label: string;
	hint?: string;
	value: T;
	shown?: string;
	choices: readonly Choice<T>[];
	onChoose: (value: T) => void;
}) {
	const [open, setOpen] = useState(false);
	const groups = [...new Set(choices.map((choice) => choice.group))];
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				<span className="menu-text">
					{label}
					{hint ? <span className="index-status">{hint}</span> : null}
				</span>
				<span className="row-value">{shown ?? choices.find((choice) => choice.value === value)?.label ?? value}</span>
			</button>
			<Sheet open={open} title={label} onClose={() => setOpen(false)}>
				{groups.map((group) => (
					<div key={group ?? ""}>
						{group ? <h3 className="list-label">{group}</h3> : null}
						<div className="menu choice-list">
							{choices
								.filter((choice) => choice.group === group)
								.map((choice) => (
									<button
										type="button"
										key={choice.value}
										disabled={choice.disabled}
										className={choice.value === value ? "selected" : ""}
										onClick={() => {
											setOpen(false);
											onChoose(choice.value);
										}}
									>
										<span className="menu-text">{choice.label}</span>
										{choice.value === value ? <CheckIcon size={16} /> : null}
									</button>
								))}
						</div>
					</div>
				))}
			</Sheet>
		</>
	);
}
