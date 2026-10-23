export function PiMark({ size = 24, live = false }: { size?: number; live?: boolean }) {
	return (
		<svg className={`pi-mark${live ? " live" : ""}`} width={size} height={size} viewBox="0 0 4 4" shapeRendering="crispEdges" aria-hidden="true">
			<path fill="#6A9FCC" d="M0 0h3v2h-1v-1h-2z" />
			<path fill="#A3A473" d="M0 1h1v1h1v1h-1v1h-1z" />
			<path className="pi-mark-cursor" fill="#E1B06E" d="M3 2h1v2h-1z" />
		</svg>
	);
}
