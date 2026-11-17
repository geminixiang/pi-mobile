import type { SimpleIcon } from "simple-icons";

const TILE_COLORS = ["coral", "blue", "yellow", "think-medium", "think-high", "ok"] as const;
const tileColor = (name: string) => TILE_COLORS[[...name].reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0) % TILE_COLORS.length];

export function Logo({ name, icon }: { name: string; icon?: SimpleIcon }) {
	return icon ? (
		<span className="logo">
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d={icon.path} fill={`#${icon.hex}`} />
			</svg>
		</span>
	) : (
		<span className="tile" style={{ "--tile": `var(--${tileColor(name)})` }}>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}
