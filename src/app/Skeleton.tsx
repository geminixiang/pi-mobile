import { PiMark } from "./PiMark.tsx";

export function TranscriptSkeleton() {
	return (
		<div className="skeleton-transcript" aria-hidden="true">
			<i className="skeleton-prompt" />
			<i className="skeleton-line" />
			<i className="skeleton-line" />
			<i className="skeleton-line short" />
			<i className="skeleton-prompt" />
			<i className="skeleton-line" />
			<i className="skeleton-line short" />
		</div>
	);
}

export function Skeleton() {
	return (
		<div className="app skeleton" aria-busy="true" aria-label="pi 啟動中">
			<div className="bar chat-bar">
				<span className="bar-pill bar-who">
					<span className="skeleton-mark">
						<PiMark size={18} live />
					</span>
					<span className="skeleton-title">
						<i />
						<i />
					</span>
				</span>
			</div>
			<TranscriptSkeleton />
			<div className="skeleton-composer" />
		</div>
	);
}
