import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { Workplace } from "../agent/workplaces.ts";
import type { ConnectionStatus } from "../agent/sandbox/phone-connection.ts";
import type { Sandbox } from "../agent/sandbox/sandbox.ts";
import { deviceNetwork } from "../agent/network.ts";
import { modelReach, type ReachState } from "../agent/reach.ts";
import { hostTraffic, modelTraffic, type Rates, STILL, type Traffic } from "../agent/traffic.ts";
import { Monitor, Sparkles, Wifi, WifiOff } from "lucide-react";
import { CLOCK } from "./clock.ts";
import { Sheet } from "./Sheet.tsx";

type Outage = { since: number; at: number };

export function useReach(provider: string): ReachState {
	const reach = modelReach(provider);
	return useSyncExternalStore(reach.onChange, reach.state);
}

function useBack(provider: string, busy: boolean): Outage | undefined {
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
	return busy ? back : undefined;
}

export function ReachNote({ provider, busy }: { provider: string; busy: boolean }) {
	const state = useReach(provider);
	const back = useBack(provider, busy);
	if (state.kind === "down") {
		return (
			<div className="link-line">
				<i className="link-mark down" />
				<span className="link-text">連不上模型，連回來會自動繼續 · {CLOCK.format(state.since)} 起</span>
				<button type="button" className="link-verb" onClick={() => modelReach(provider).check()}>
					重試
				</button>
			</div>
		);
	}
	if (!back) return null;
	return (
		<div className="link-line">
			<i className="link-mark up" />
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
			<i className="link-mark down" />
			連不上模型 · {CLOCK.format(state.since)} 起
		</span>
	);
}

const unwatched = () => () => undefined;

function useOnline(): boolean {
	return useSyncExternalStore(deviceNetwork.onChange, deviceNetwork.online);
}

function useHost(sandbox: Sandbox | undefined): ConnectionStatus | undefined {
	return useSyncExternalStore(
		(onChange) => sandbox?.subscribe(onChange) ?? (() => undefined),
		() => sandbox?.status,
	);
}

function useRates(traffic: Traffic | undefined): Rates {
	return useSyncExternalStore(traffic?.onChange ?? unwatched, () => traffic?.rates() ?? STILL);
}

type Line = "up" | "idle" | "down";

function hostLine(status: ConnectionStatus | undefined): Line {
	switch (status?.kind) {
		case "connected":
			return "up";
		case "reattaching":
		case "offline":
		case "lost":
			return "down";
		default:
			return "idle";
	}
}

type Row =
	| { kind: "offline" }
	| { kind: "model-down"; since: number }
	| { kind: "host-lost"; at: number }
	| { kind: "host-waiting"; since: number; offline: boolean }
	| { kind: "back" }
	| { kind: "busy" }
	| { kind: "idle" };

function rowOf(online: boolean, reach: ReachState, host: ConnectionStatus | undefined, back: Outage | undefined, busy: boolean): Row {
	if (!online) return { kind: "offline" };
	if (reach.kind === "down") return { kind: "model-down", since: reach.since };
	if (back) return { kind: "back" };
	if (host?.kind === "lost") return { kind: "host-lost", at: host.at };
	if (host?.kind === "reattaching" || host?.kind === "offline") return { kind: "host-waiting", since: host.since, offline: host.kind === "offline" };
	return busy ? { kind: "busy" } : { kind: "idle" };
}

const KB = 1000;

function rate(bytesPerSecond: number): string {
	if (bytesPerSecond < KB) return `${Math.round(bytesPerSecond)} B/s`;
	if (bytesPerSecond < KB * KB) return `${(bytesPerSecond / KB).toFixed(1)} kB/s`;
	return `${(bytesPerSecond / KB / KB).toFixed(1)} MB/s`;
}

const LABEL_COLUMNS = 14;

function fitted(name: string): string {
	const kept: string[] = [];
	let columns = 0;
	for (const char of name) {
		columns += char.charCodeAt(0) > 0x2e80 ? 2 : 1;
		if (columns > LABEL_COLUMNS) return `${kept.join("")}…`;
		kept.push(char);
	}
	return name;
}

type Computer = { name: string; line: Line; rates: Rates };

export type LinkNode = "model" | "phone" | "computer";

export function LinksSection({
	live,
	provider,
	model,
	busy,
	place,
	onOpen,
	children,
}: {
	live: boolean;
	provider: string;
	model: string;
	busy: boolean;
	place: Workplace | undefined;
	onOpen: (node: LinkNode) => void;
	children: ReactNode;
}) {
	const online = useOnline();
	const reach = useReach(provider);
	const back = useBack(provider, busy);
	const host = useHost(place?.kind === "computer" ? place.sandbox : undefined);
	const down = useRates(live ? modelTraffic(provider) : undefined).down;
	const hostRates = useRates(live && place?.kind === "computer" ? hostTraffic(place.host.address) : undefined);
	const row = rowOf(online, reach, host, back, busy);
	const computer: Computer | undefined =
		place?.kind === "computer" ? { name: place.computer.name, line: hostLine(host), rates: hostRates } : place?.kind === "missing" ? { name: "已移除的電腦", line: "down", rates: STILL } : undefined;
	return (
		<section className="links" data-model={reach.kind === "down" ? "down" : back ? "back" : "up"} data-busy={busy || undefined} data-live={live || undefined}>
			<div className="links-label">
				<h3 className="strip-label">連線</h3>
				{online ? null : <span className="links-via offline">沒有網路</span>}
				{online && computer ? <Via /> : null}
			</div>
			<div className="links-map">
				<svg viewBox="0 0 280 112" aria-hidden="true">

					<line className="links-line model" x1="46" y1="48" x2="112" y2="48" />
					<g className="links-broken model">
						<line x1="46" y1="48" x2="70" y2="48" />
						<line x1="88" y1="48" x2="112" y2="48" />
						<path d="M77 42l-3 12M84 42l-3 12" />
					</g>
					<g className="links-flow right" data-on={down > 0 || undefined}>
						<rect x="50" y="46" width="9" height="4" rx="2" />
						<rect x="50" y="46" width="9" height="4" rx="2" />
						<rect x="50" y="46" width="9" height="4" rx="2" />
						<rect x="50" y="46" width="9" height="4" rx="2" />
					</g>
					<g className="links-probe">
						<circle cx="108" cy="48" r="4" />
						<circle cx="108" cy="48" r="4" />
					</g>

					<circle className="links-pi" cx="140" cy="48" r="25" />
					<rect className="links-phone" x="131" y="34" width="18" height="28" rx="4.5" />
					<path className="links-phone" d="M137.5 38h5M138 58.5h4" />

					<circle className="links-ping" cx="26" cy="48" r="20" />
					<circle className="links-burst" cx="26" cy="48" r="20" />
					<g className="links-model">
						<circle className="links-node" cx="26" cy="48" r="20" />
						<path className="links-glyph" d="M26 37c1 6 3.2 8.6 9.5 11-6.3 2.4-8.5 5-9.5 11-1-6-3.2-8.6-9.5-11 6.3-2.4 8.5-5 9.5-11z" />
						<text className="links-name" x="26" y="88">
							{fitted(model)}
						</text>
					</g>
					<g className="links-badge bad">
						<circle cx="41" cy="33" r="7" />
						<path d="M41 29.8v3.6M41 36.1v.1" />
					</g>
					<g className="links-badge good">
						<circle cx="41" cy="33" r="7" />
						<path d="M38 33.2l2 2 3.4-3.6" />
					</g>
					{down > 0 ? (
						<text className="links-rate" x="83" y="28">
							↓{rate(down)}
						</text>
					) : null}

					{computer ? <ComputerLink computer={computer} /> : null}
				</svg>
				<button type="button" className="links-tap model" onClick={() => onOpen("model")} aria-label={`模型：${model}`} />
				<button type="button" className="links-tap pi" onClick={() => onOpen("phone")} aria-label="這支手機" />
				{computer ? <button type="button" className="links-tap computer" onClick={() => onOpen("computer")} aria-label={`電腦：${computer.name}`} /> : null}
			</div>
			<StatusRow key={row.kind} row={row} onRetry={() => modelReach(provider).check()} />
			{host?.kind === "lost" ? <span className="note error">{host.reason}</span> : null}
			{children}
		</section>
	);
}

function ComputerLink({ computer }: { computer: Computer }) {
	const { up, down } = computer.rates;
	return (
		<g className="links-host" data-line={computer.line}>
			<line className="links-line host-up" x1="168" y1="44" x2="234" y2="44" />
			<line className="links-line host-down" x1="168" y1="52" x2="234" y2="52" />
			<g className="links-broken host">
				<line x1="168" y1="48" x2="192" y2="48" />
				<line x1="210" y1="48" x2="234" y2="48" />
				<path d="M199 42l-3 12M206 42l-3 12" />
			</g>
			<g className="links-flow right sent" data-on={up > 0 || undefined}>
				<rect x="170" y="42" width="8" height="4" rx="2" />
				<rect x="170" y="42" width="8" height="4" rx="2" />
			</g>
			<g className="links-flow left" data-on={down > 0 || undefined}>
				<rect x="224" y="50" width="8" height="4" rx="2" />
				<rect x="224" y="50" width="8" height="4" rx="2" />
			</g>
			<circle className="links-node" cx="254" cy="48" r="20" />
			<rect className="links-screen" x="241" y="42" width="26" height="10" rx="3" />
			<path className="links-stand" d="M245 56h18" />
			<circle className="links-led" cx="246.5" cy="47" r="1.3" />
			<text className="links-name" x="254" y="88">
				{fitted(computer.name)}
			</text>
			{up > 0 ? (
				<text className="links-rate sent" x="201" y="28">
					↑{rate(up)}
				</text>
			) : null}
			{down > 0 ? (
				<text className="links-rate" x="201" y="72">
					↓{rate(down)}
				</text>
			) : null}
		</g>
	);
}

function Via() {
	return (
		<span className="links-via">
			<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
				<circle cx="1.5" cy="1.5" r="1.2" />
				<circle cx="5" cy="1.5" r="1.2" />
				<circle cx="8.5" cy="1.5" r="1.2" />
				<circle className="dim" cx="1.5" cy="5" r="1.2" />
				<circle cx="5" cy="5" r="1.2" />
				<circle className="dim" cx="8.5" cy="5" r="1.2" />
				<circle className="dim" cx="1.5" cy="8.5" r="1.2" />
				<circle cx="5" cy="8.5" r="1.2" />
				<circle className="dim" cx="8.5" cy="8.5" r="1.2" />
			</svg>
			Tailscale
		</span>
	);
}

function StatusRow({ row, onRetry }: { row: Row; onRetry: () => void }) {
	switch (row.kind) {
		case "offline":
			return (
				<div className="links-row down">
					<i className="links-dot radar" />
					沒有網路
				</div>
			);
		case "model-down":
			return (
				<div className="links-row down">
					<i className="links-dot radar" />
					<b>{CLOCK.format(row.since)}</b>
					<small>起 · 偵測中</small>
					<button type="button" className="links-retry" onClick={onRetry}>
						<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M20 12a8 8 0 1 1-2.3-5.7" />
							<path d="M20 4v5h-5" />
						</svg>
						重試
					</button>
				</div>
			);
		case "host-lost":
			return (
				<div className="links-row down">
					<i className="links-dot" />
					<b>{CLOCK.format(row.at)}</b>
					<small>電腦斷線</small>
				</div>
			);
		case "host-waiting":
			return (
				<div className="links-row waiting">
					<i className="links-dot radar" />
					<b>{CLOCK.format(row.since)}</b>
					<small>起 · {row.offline ? "等網路" : "重新連線電腦"}</small>
				</div>
			);
		case "back":
			return (
				<div className="links-row back">
					<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M5 12.5l4.5 4.5L19 7.5" />
					</svg>
					已恢復 · 繼續回覆
				</div>
			);
		case "busy":
			return (
				<div className="links-row">
					<span className="links-bars">
						<i />
						<i />
						<i />
					</span>
					回覆中
				</div>
			);
		case "idle":
			return (
				<div className="links-row">
					<i className="links-dot" />
					一切正常
				</div>
			);
	}
}

function LinkRow({ icon, name, status, since, children }: { icon: ReactNode; name: string; status: Line; since?: number; children?: ReactNode }) {
	const said = status === "up" ? "連得上" : status === "idle" ? "還沒連" : since === undefined ? "連不上" : `連不上 · ${CLOCK.format(since)} 起`;
	return (
		<div className="link-row" data-line={status}>
			<span className="place-icon" aria-hidden="true">
				{icon}
			</span>
			<span className="menu-text">
				{name}
				<span className="link-row-status">{said}</span>
			</span>
			{children}
		</div>
	);
}

export function ProviderRow({ provider, name }: { provider: string; name: string }) {
	const reach = useReach(provider);
	return (
		<LinkRow icon={<Sparkles size={20} strokeWidth={1.6} />} name={name} status={reach.kind} since={reach.kind === "down" ? reach.since : undefined}>
			{reach.kind === "down" ? (
				<button type="button" className="link-verb" onClick={() => modelReach(provider).check()}>
					重試
				</button>
			) : null}
		</LinkRow>
	);
}

export function HostRow({ name, mode, sandbox }: { name: string; mode: string; sandbox: Sandbox }) {
	const status = useHost(sandbox);
	const since = status?.kind === "lost" ? status.at : status?.kind === "reattaching" || status?.kind === "offline" ? status.since : undefined;
	return (
		<>
			<LinkRow icon={<Monitor size={20} strokeWidth={1.6} />} name={`${name} · ${mode}`} status={hostLine(status)} since={since} />
			{status?.kind === "lost" ? <span className="note error">{status.reason}</span> : null}
		</>
	);
}

export function PhoneSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
	const online = useOnline();
	return (
		<Sheet open={open} title="這支手機" onClose={onClose}>
			<div className="link-rows">
				<LinkRow icon={online ? <Wifi size={20} strokeWidth={1.6} /> : <WifiOff size={20} strokeWidth={1.6} />} name="網路" status={online ? "up" : "down"} />
			</div>
			{children}
		</Sheet>
	);
}
