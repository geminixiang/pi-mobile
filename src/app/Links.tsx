import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { Workplace } from "../agent/workplaces.ts";
import type { ConnectionStatus } from "../agent/sandbox/phone-connection.ts";
import type { Sandbox } from "../agent/sandbox/sandbox.ts";
import { deviceNetwork } from "../agent/network.ts";
import { modelReach, type ReachState } from "../agent/reach.ts";
import { CLOCK } from "./clock.ts";
import { Sheet } from "./Sheet.tsx";

type Outage = { since: number; at: number };

export function useReach(provider: string): ReachState {
	const reach = modelReach(provider);
	return useSyncExternalStore(reach.onChange, reach.state);
}

export function ReachNote({ provider, busy }: { provider: string; busy: boolean }) {
	const state = useReach(provider);
	const [back, setBack] = useState<Outage>();
	useEffect(() => {
		const reach = modelReach(provider);
		return reach.onChange(() => {
			const now = reach.state();
			if (now.kind === "up" && now.back) setBack(now.back);
		});
	}, [provider]);
	useEffect(() => {
		if (!busy) setBack(undefined);
	}, [busy]);
	if (state.kind === "down") {
		return (
			<div className="link-line">
				<i className="link-mark lost" />
				<span className="link-text">連不上模型，連回來會自動繼續 · {CLOCK.format(state.since)} 起</span>
				<button type="button" className="link-verb" onClick={() => modelReach(provider).check()}>
					重試
				</button>
			</div>
		);
	}
	if (!back || !busy) return null;
	return (
		<div className="link-line">
			<i className="link-mark" />
			<span className="link-text">連不上模型 {Math.max(1, Math.round((back.at - back.since) / 60_000))} 分鐘，已接回</span>
			<span>{CLOCK.format(back.at)}</span>
		</div>
	);
}

export function ModelLine({ provider, children }: { provider: string; children: ReactNode }) {
	const state = useReach(provider);
	if (state.kind === "up") return <span className="bar-model">{children}</span>;
	return (
		<span className="bar-model lost">
			<i className="link-mark lost" />
			連不上模型 · {CLOCK.format(state.since)} 起
		</span>
	);
}

function useOnline(): boolean {
	return useSyncExternalStore(deviceNetwork.onChange, deviceNetwork.online);
}

function useHost(sandbox: Sandbox): ConnectionStatus {
	return useSyncExternalStore(
		(onChange) => sandbox.subscribe(onChange),
		() => sandbox.status,
	);
}

function hostDown(status: ConnectionStatus): number | undefined {
	if (status.kind === "lost") return status.at;
	if (status.kind === "offline" || status.kind === "reattaching") return status.since;
	return undefined;
}

function Row({ name, sub, down }: { name: string; sub: string; down: { since?: number } | undefined }) {
	return (
		<div className="list-row">
			<div className="list-open">
				<i className={`link-mark${down ? " lost" : ""}`} />
				<div className="list-text">
					<span className="list-name">{name}</span>
					<span className="list-sub">{sub}</span>
				</div>
			</div>
			<span className="list-meta">{down?.since === undefined ? "" : `${CLOCK.format(down.since)} 起`}</span>
		</div>
	);
}

function HostRow({ name, sandbox }: { name: string; sandbox: Sandbox }) {
	const since = hostDown(useHost(sandbox));
	return <Row name={`電腦 · ${name}`} sub={since === undefined ? "連得上" : "連不上"} down={since === undefined ? undefined : { since }} />;
}

export function LinksSheet({ open, onClose, provider, model, place }: { open: boolean; onClose: () => void; provider: string; model: string; place: Workplace | undefined }) {
	const online = useOnline();
	const state = useReach(provider);
	return (
		<Sheet open={open} title="連線" onClose={onClose}>
			<div className="list link-rows">
				<Row name="手機網路" sub={online ? "有網路" : "沒有網路"} down={online ? undefined : {}} />
				<Row name={`模型 · ${model}`} sub={state.kind === "up" ? "連得上" : "連不上"} down={state.kind === "down" ? { since: state.since } : undefined} />
				{place?.kind === "computer" ? <HostRow name={place.computer.name} sandbox={place.sandbox} /> : null}
			</div>
			<button type="button" className="link-verb" onClick={() => modelReach(provider).check()}>
				立即重試
			</button>
		</Sheet>
	);
}
