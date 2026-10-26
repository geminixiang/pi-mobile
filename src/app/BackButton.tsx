import { BackIcon } from "./icons.tsx";

export function BackButton({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" className="icon-button" onClick={onClick} aria-label="返回">
			<BackIcon />
		</button>
	);
}
