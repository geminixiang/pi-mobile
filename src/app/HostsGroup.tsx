import { type ReactNode, useEffect, useState } from "react";
import { type Host, hostFrom, type HostInfo, listPeers, parseHosts, type Peer, prepareContainers, probeHost } from "../agent/sandbox/host.ts";
import { Apps } from "../agent/tools/apps.ts";
import { messageOf, orLogged } from "../promise.ts";
import { CopyButton } from "./CopyButton.tsx";
import { ShareIcon } from "./icons.tsx";

const INSTALL_HOST = "curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh";

function Copyable({ text, children }: { text: string; children?: ReactNode }) {
	return (
		<div className="copyable">
			<pre className="console">{children ?? text}</pre>
			<div className="row-buttons">
				<button
					type="button"
					className="icon-button small"
					aria-label="分享"
					onClick={() => void orLogged(Apps.share({ text, title: "在電腦上安裝 pi-mobile" }), "hosts.share_failed", undefined)}
				>
					<ShareIcon size={16} />
				</button>
				<CopyButton text={text} />
			</div>
		</div>
	);
}

type Preparing = { state: "idle" } | { state: "running"; detail: string } | { state: "error"; detail: string };

export function usePrepare(host: Host | undefined): [Preparing, (target?: Host) => Promise<boolean>] {
	const [preparing, setPreparing] = useState<Preparing>({ state: "idle" });
	const prepare = async (target: Host | undefined = host) => {
		if (!target) return false;
		setPreparing({ state: "running", detail: "" });
		try {
			await prepareContainers(target, (detail) => setPreparing({ state: "running", detail }));
			setPreparing({ state: "idle" });
			return true;
		} catch (error) {
			setPreparing({ state: "error", detail: messageOf(error) });
			return false;
		}
	};
	return [preparing, prepare];
}

export function PrepareStatus({ preparing }: { preparing: Preparing }) {
	if (preparing.state === "running" && preparing.detail) return <span className="check-progress">準備容器：{preparing.detail}</span>;
	if (preparing.state === "error") return <span className="check-error">{preparing.detail}</span>;
	return null;
}

function HostRow({ host, onRemove }: { host: Host; onRemove: () => void }) {
	return (
		<div className="machine">
			<div className="check-row">
				<span className="menu-text">
					{host.name}
					<span className="menu-hint">
						{host.os === "darwin" ? "macOS" : "Linux"} · {host.user}
					</span>
				</span>
				<button type="button" className="btn" onClick={onRemove}>
					移除
				</button>
			</div>
		</div>
	);
}

function DefaultComputer({ hosts, computer, onChoose }: { hosts: Host[]; computer: string; onChoose: (key: string) => void }) {
	const [preparing, prepare] = usePrepare(undefined);
	const choose = (key: string) => {
		const [id, mode] = key.split(":");
		const host = hosts.find((item) => item.id === id);
		if (mode !== "container" || !host) return onChoose(key);
		void prepare(host).then((ready) => ready && onChoose(key));
	};
	return (
		<div className="machine">
			<label className="check-row">
				<span className="menu-text">預設</span>
				<select className="field" value={computer} aria-label="預設" disabled={preparing.state === "running"} onChange={(event) => choose(event.target.value)}>
					<option value="">手機</option>
					{hosts.map((host) => [
						<option key={`${host.id}:direct`} value={`${host.id}:direct`}>
							{host.name} · 直接
						</option>,
						host.engine ? (
							<option key={`${host.id}:container`} value={`${host.id}:container`}>
								{host.name} · 容器
							</option>
						) : null,
					])}
				</select>
			</label>
			<PrepareStatus preparing={preparing} />
		</div>
	);
}

type Found = { peer: Peer; info: HostInfo | undefined };

function useFound(hosts: Host[]): Found[] | undefined {
	const [found, setFound] = useState<Found[]>();
	const known = hosts.map((host) => host.address).join(" ");
	useEffect(() => {
		let stale = false;
		void (async () => {
			for (const host of hosts) {
				const peers = await orLogged(listPeers(host), "hosts.peers_unavailable", undefined, { host: host.address });
				if (!peers) continue;
				const others = peers.filter((peer) => !hosts.some((added) => added.address === peer.dnsName));
				const answers = await Promise.all(others.map(async (peer) => ({ peer, info: await orLogged(probeHost(peer.dnsName, AbortSignal.timeout(4000)), "hosts.peer_unreachable", undefined, { peer: peer.dnsName }) })));
				if (!stale) setFound(answers.sort((a, b) => Number(Boolean(b.info)) - Number(Boolean(a.info)) || a.peer.name.localeCompare(b.peer.name)));
				return;
			}
			if (!stale) setFound(undefined);
		})();
		return () => {
			stale = true;
		};
	}, [known]);
	return found;
}

type Adding = { state: "idle" } | { state: "checking" } | { state: "error"; detail: string };

export function HostsGroup({ value, computer, onChange }: { value: string; computer: string; onChange: (hosts: Host[], computer: string) => void }) {
	const hosts = parseHosts(value);
	const found = useFound(hosts);
	const [address, setAddress] = useState("");
	const [adding, setAdding] = useState<Adding>({ state: "idle" });
	const add = (name: string, answered?: HostInfo) => {
		setAdding({ state: "checking" });
		(answered ? Promise.resolve(answered) : probeHost(name)).then(
			(info) => {
				const known = hosts.find((host) => host.address === (info.dnsName || name));
				const host = hostFrom(name, info, known);
				const next = known ? hosts.map((item) => (item.id === known.id ? host : item)) : [...hosts, host];
				onChange(next, computer || `${host.id}:direct`);
				setAddress("");
				setAdding({ state: "idle" });
			},
			(error: unknown) => setAdding({ state: "error", detail: messageOf(error) }),
		);
	};
	const ready = found?.filter((item) => item.info) ?? [];
	const missing = found?.filter((item) => !item.info) ?? [];
	const manual = (
		<div className="machine-add">
			<label>
				<span>電腦名稱</span>
				<input
					value={address}
					onChange={(event) => {
						setAddress(event.target.value);
						setAdding({ state: "idle" });
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && address.trim()) add(address.trim());
					}}
					placeholder="Tailscale 裡的名稱或 IP"
					autoCapitalize="off"
					autoComplete="off"
					enterKeyHint="go"
				/>
			</label>
			<div className="row-buttons">
				<button type="button" className="btn primary" disabled={!address.trim() || adding.state === "checking"} onClick={() => add(address.trim())}>
					{adding.state === "checking" ? "連線中…" : "加入"}
				</button>
			</div>
		</div>
	);
	return (
		<>
			{hosts.map((host) => (
				<HostRow
					key={host.id}
					host={host}
					onRemove={() => onChange(hosts.filter((item) => item.id !== host.id), computer.startsWith(`${host.id}:`) ? "" : computer)}
				/>
			))}
			{hosts.length > 0 ? <DefaultComputer hosts={hosts} computer={computer} onChoose={(key) => onChange(hosts, key)} /> : null}
			{ready.map(({ peer, info }) => (
				<div className="machine" key={peer.dnsName}>
					<div className="check-row">
						<span className="menu-text">
							{peer.name}
							<span className="menu-hint">{peer.os === "darwin" ? "macOS" : "Linux"}</span>
						</span>
						<button type="button" className="btn" disabled={adding.state === "checking"} onClick={() => add(peer.dnsName, info)}>
							加入
						</button>
					</div>
				</div>
			))}
			{hosts.length === 0 ? manual : null}
			{adding.state === "error" ? <span className="check-error machine-error">{adding.detail}</span> : null}
			{missing.length > 0 || hosts.length === 0 ? (
				<div className="pair-steps">
					<p>{missing.length > 0 ? `還沒裝 pi-mobile：${missing.map((item) => item.peer.name).join("、")}。` : null}在電腦的終端機執行：</p>
					<Copyable text={INSTALL_HOST} />
				</div>
			) : null}
			{hosts.length > 0 ? (
				<details className="manual">
					<summary>手動輸入</summary>
					{manual}
				</details>
			) : null}
		</>
	);
}
