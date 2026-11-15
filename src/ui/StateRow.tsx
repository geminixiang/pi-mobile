export function StateRow({ label, hint, on, onClick }: { label: string; hint?: string; on: boolean; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick}>
			<span className="menu-text">
				{label}
				{hint ? <span className="index-status">{hint}</span> : null}
			</span>
			<i className={`row-dot${on ? "" : " off"}`} aria-label={on ? "已開啟" : "未開啟"} />
		</button>
	);
}
