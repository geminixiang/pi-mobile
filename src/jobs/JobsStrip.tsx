import { Fragment, type PointerEvent, useContext, useEffect, useRef, useState } from "react";
import { StopIcon } from "../app/icons.tsx";
import { haptic, HOLD_MS, HOLD_SLOP } from "../app/haptics.ts";
import { orLogged } from "../promise.ts";
import { clock, JobsContext, type Peek, type RunningJob, useNow } from "./JobsContext.ts";

const SHOWN = 3;
const PEEK_EVERY_MS = 1500;
const CLOSE_MS = 110;

type Stopping = { state: "idle" } | { state: "stopping" } | { state: "failed" };
type Read = Peek | "loading" | "gone";
type Peeking = { state: "closed" } | { state: "open" | "closing"; job: string; read: Read };

export function JobsStrip() {
	const jobs = useContext(JobsContext);
	const running = jobs?.jobs ?? [];
	const now = useNow(running.length > 0);
	const [expanded, setExpanded] = useState(false);
	const [peeking, setPeeking] = useState<Peeking>({ state: "closed" });
	const peeked = peeking.state === "open" ? peeking.job : undefined;
	useEffect(() => {
		if (!peeked || !jobs) return;
		let live = true;
		const read = async () => {
			const peek = await orLogged(jobs.peek(peeked), "jobs.peek_failed", undefined, { job: peeked });
			if (live) setPeeking((current) => (current.state !== "closed" && current.job === peeked ? { ...current, read: peek ?? "gone" } : current));
		};
		void read();
		const timer = setInterval(() => void read(), PEEK_EVERY_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [peeked, jobs]);
	const release = () => {
		setPeeking((current) => (current.state === "open" ? { ...current, state: "closing" } : current));
		setTimeout(() => setPeeking((current) => (current.state === "closing" ? { state: "closed" } : current)), CLOSE_MS);
	};
	if (!jobs || running.length === 0) return null;
	const shown = expanded || running.length <= SHOWN ? running : running.slice(0, SHOWN);
	const hidden = running.length - shown.length;
	const open = peeking.state === "closed" ? undefined : peeking;
	return (
		<>
			{open ? <div className={`job-peek-backdrop${open.state === "closing" ? " closing" : ""}`} /> : null}
			<ul className="queue jobs">
				{shown.map((job) => (
					<Fragment key={job.job}>
						{open?.job === job.job ? <JobPeek read={open.read} closing={open.state === "closing"} /> : null}
						<JobRow job={job} now={now} peeked={open?.job === job.job} stop={jobs.stop} onPeek={() => setPeeking({ state: "open", job: job.job, read: "loading" })} onRelease={release} />
					</Fragment>
				))}
				{hidden > 0 ? (
					<li>
						<button type="button" className="jobs-more" onClick={() => setExpanded(true)}>
							還有 {hidden} 個背景指令
						</button>
					</li>
				) : null}
			</ul>
		</>
	);
}

type Hold = { state: "idle" } | { state: "pressing"; x: number; y: number; timer: ReturnType<typeof setTimeout> } | { state: "held" };

function useHold(onHold: () => void, onRelease: () => void) {
	const hold = useRef<Hold>({ state: "idle" });
	const [pressing, setPressing] = useState(false);
	const end = () => {
		const was = hold.current;
		if (was.state === "pressing") clearTimeout(was.timer);
		hold.current = { state: "idle" };
		setPressing(false);
		if (was.state === "held") onRelease();
	};
	const handlers = {
		onPointerDown: (event: PointerEvent<HTMLElement>) => {
			if (event.target instanceof Element && event.target.closest("button")) return;
			const target = event.currentTarget;
			const { pointerId, clientX, clientY } = event;
			const timer = setTimeout(() => {
				hold.current = { state: "held" };
				setPressing(false);
				target.setPointerCapture(pointerId);
				haptic("press");
				onHold();
			}, HOLD_MS);
			hold.current = { state: "pressing", x: clientX, y: clientY, timer };
			setPressing(true);
		},
		onPointerMove: (event: PointerEvent<HTMLElement>) => {
			const now = hold.current;
			if (now.state === "pressing" && Math.hypot(event.clientX - now.x, event.clientY - now.y) > HOLD_SLOP) end();
		},
		onPointerUp: end,
		onPointerCancel: end,
		onContextMenu: (event: { preventDefault(): void }) => event.preventDefault(),
	};
	return { pressing, handlers };
}

function JobRow({ job, now, peeked, stop, onPeek, onRelease }: { job: RunningJob; now: number; peeked: boolean; stop: (job: string) => Promise<void>; onPeek: () => void; onRelease: () => void }) {
	const [stopping, setStopping] = useState<Stopping>({ state: "idle" });
	const { pressing, handlers } = useHold(onPeek, onRelease);
	const press = async () => {
		setStopping({ state: "stopping" });
		try {
			await stop(job.job);
		} catch {
			setStopping({ state: "failed" });
		}
	};
	const mode = stopping.state === "stopping" ? "停止中" : stopping.state === "failed" ? "停不下來，再按一次" : `背景執行中 · ${clock(now - job.since)}`;
	return (
		<li className={peeked ? "peeked" : pressing ? "pressing" : undefined} {...handlers}>
			<span className="queue-mode">{mode}</span>
			<span className="queue-text">{job.label}</span>
			<button type="button" className="icon-button small" aria-label="停止指令" disabled={stopping.state === "stopping"} onClick={() => void press()}>
				<StopIcon />
			</button>
		</li>
	);
}

function JobPeek({ read, closing }: { read: Read; closing: boolean }) {
	return (
		<li className={`job-peek${closing ? " closing" : ""}`} aria-live="polite">
			{read === "loading" ? <p className="job-peek-note">讀取中…</p> : read === "gone" ? <p className="job-peek-note">讀不到這個指令，可能剛結束</p> : null}
			{typeof read === "object" ? (
				<>
					<pre className="job-peek-command">{read.command}</pre>
					<div className="job-peek-output">
						<pre>{read.output.trimEnd() || "（還沒有輸出）"}</pre>
					</div>
				</>
			) : null}
		</li>
	);
}
