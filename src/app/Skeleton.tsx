// The app's outline while it starts: bar, a conversation's shape, and the composer's line, where they will be, so the
// screen does not jump from a centered mark to the app. index.html has the same markup, painted before any script
// loads; keep the two alike. Styles: styles.css, Skeleton.
import { PiMark } from "./PiMark.tsx";

/** A conversation's shape: a prompt band and an answer's lines. */
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
			<div className="bar">
				<span className="skeleton-mark">
					<PiMark size={18} live />
				</span>
				<span className="skeleton-title">
					<i />
					<i />
				</span>
			</div>
			<TranscriptSkeleton />
			<div className="skeleton-composer" />
		</div>
	);
}
