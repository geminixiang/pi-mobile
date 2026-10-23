export function Segmented<T extends string>({
	label,
	options,
	value,
	onChange,
	inline = false,
}: {
	label: string;
	options: readonly { value: T; label: string; disabled?: boolean }[];
	value: T;
	onChange: (value: T) => void;
	inline?: boolean;
}) {
	return (
		<div className={`segmented${inline ? " inline" : ""}`} role="radiogroup" aria-label={label}>
			{options.map((option) => (
				<button
					type="button"
					role="radio"
					aria-checked={option.value === value}
					key={option.value}
					className={option.value === value ? "selected" : ""}
					disabled={option.disabled}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
