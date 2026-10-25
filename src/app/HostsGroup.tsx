import { type ReactNode, useEffect, useState } from "react";
import { hasPiMobile, hostFrom, listPeers, type PairedHost, pairHost, type Peer, prepareContainers, probeHost, unpairHost, watchPrepare } from "../agent/sandbox/host.ts";
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

export function usePrepare(host: PairedHost | undefined): [Preparing, (target?: PairedHost) => Promise<boolean>] {
	const [preparing, setPreparing] = useState<Preparing>({ state: "idle" });
	const follow = async (done: Promise<void>) => {
		try {
			await done;
			setPreparing({ state: "idle" });
			return true;
		} catch (error) {
			setPreparing({ state: "error", detail: messageOf(error) });
			return false;
		}
	};
	const prepare = (target: PairedHost | undefined = host) => {
		if (!target) return Promise.resolve(false);
		setPreparing({ state: "running", detail: "" });
		return follow(prepareContainers(target, (detail) => setPreparing({ state: "running", detail })));
	};
	const address = host?.address;
	useEffect(() => {
		if (!host) return undefined;
		let current = true;
		const running = watchPrepare(host, (detail) => current && setPreparing({ state: "running", detail }));
		if (running) {
			setPreparing({ state: "running", detail: "" });
			void follow(running);
		}
		return () => {
			current = false;
		};
	}, [address]);
	return [preparing, prepare];
}

export function PrepareStatus({ preparing }: { preparing: Preparing }) {
	if (preparing.state === "running" && preparing.detail) return <span className="check-progress">準備容器：{preparing.detail}</span>;
	if (preparing.state === "error") return <span className="check-error">{preparing.detail}</span>;
	return null;
}

function CodeField({ value, onChange, onEnter }: { value: string; onChange: (code: string) => void; onEnter: () => void }) {
	return (
		<input
			className="field code-field"
			value={value}
			onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
			onKeyDown={(event) => {
				if (event.key === "Enter" && value.length === 6) onEnter();
			}}
			placeholder="6 位數"
			aria-label="配對碼"
			inputMode="numeric"
			autoComplete="one-time-code"
			enterKeyHint="go"
		/>
	);
}

function HostRow({ host, busy, onPair, onRemove }: { host: PairedHost; busy: boolean; onPair: (code: string) => void; onRemove: () => void }) {
	const [code, setCode] = useState("");
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
			{host.key ? null : (
				<div className="check-row pair-row">
					<CodeField value={code} onChange={setCode} onEnter={() => onPair(code)} />
					<button type="button" className="btn primary" disabled={code.length !== 6 || busy} onClick={() => onPair(code)}>
						配對
					</button>
				</div>
			)}
		</div>
	);
}

function PeerRow({ peer, busy, onAdd }: { peer: Peer; busy: boolean; onAdd: (code: string) => void }) {
	const [code, setCode] = useState("");
	return (
		<div className="machine">
			<div className="check-row">
				<span className="menu-text">
					{peer.name}
					<span className="menu-hint">{peer.os === "darwin" ? "macOS" : "Linux"}</span>
				</span>
			</div>
			<div className="check-row pair-row">
				<CodeField value={code} onChange={setCode} onEnter={() => onAdd(code)} />
				<button type="button" className="btn" disabled={code.length !== 6 || busy} onClick={() => onAdd(code)}>
					加入
				</button>
			</div>
		</div>
	);
}

function DefaultComputer({ hosts, computer, onChoose }: { hosts: PairedHost[]; computer: string; onChoose: (key: string) => void }) {
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

type Found = { peer: Peer; installed: boolean };

function useFound(hosts: PairedHost[]): Found[] | undefined {
	const [found, setFound] = useState<Found[]>();
	const known = hosts.map((host) => host.address).join(" ");
	useEffect(() => {
		let stale = false;
		void (async () => {
			for (const host of hosts) {
				const peers = await orLogged(listPeers(host), "hosts.peers_unavailable", undefined, { host: host.address });
				if (!peers) continue;
				const others = peers.filter((peer) => !hosts.some((added) => added.address === peer.dnsName));
				const answers = await Promise.all(others.map(async (peer) => ({ peer, installed: await hasPiMobile(peer.dnsName, AbortSignal.timeout(4000)) })));
				if (!stale) setFound(answers.sort((a, b) => Number(b.installed) - Number(a.installed) || a.peer.name.localeCompare(b.peer.name)));
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

export function HostsGroup({ hosts, computer, onChange }: { hosts: PairedHost[]; computer: string; onChange: (hosts: PairedHost[], computer: string) => void }) {
	const found = useFound(hosts);
	const [address, setAddress] = useState("");
	const [code, setCode] = useState("");
	const [adding, setAdding] = useState<Adding>({ state: "idle" });
	const add = (name: string, pairingCode: string) => {
		setAdding({ state: "checking" });
		void (async () => {
			const key = await pairHost(name, pairingCode);
			const info = await probeHost({ address: name, key });
			const known = hosts.find((host) => host.address === (info.dnsName || name));
			const host: PairedHost = { ...hostFrom(name, info, known), key };
			const next = known ? hosts.map((item) => (item.id === known.id ? host : item)) : [...hosts, host];
			onChange(next, computer || `${host.id}:direct`);
			setAddress("");
			setCode("");
			setAdding({ state: "idle" });
		})().catch((error: unknown) => setAdding({ state: "error", detail: messageOf(error) }));
	};
	const ready = found?.filter((item) => item.installed) ?? [];
	const missing = found?.filter((item) => !item.installed) ?? [];
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
					placeholder="Tailscale 裡的名稱"
					autoCapitalize="off"
					autoComplete="off"
					enterKeyHint="next"
				/>
			</label>
			<label>
				<span>配對碼</span>
				<CodeField
					value={code}
					onChange={(next) => {
						setCode(next);
						setAdding({ state: "idle" });
					}}
					onEnter={() => address.trim() && add(address.trim(), code)}
				/>
			</label>
			<div className="row-buttons">
				<button type="button" className="btn primary" disabled={!address.trim() || code.length !== 6 || adding.state === "checking"} onClick={() => add(address.trim(), code)}>
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
					busy={adding.state === "checking"}
					onPair={(pairingCode) => add(host.address, pairingCode)}
					onRemove={() => {
						onChange(
							hosts.filter((item) => item.id !== host.id),
							computer.startsWith(`${host.id}:`) ? "" : computer,
						);
						if (host.key) void unpairHost(host).catch((error: unknown) => setAdding({ state: "error", detail: `已從手機移除，但電腦上的配對還在：${messageOf(error)}` }));
					}}
				/>
			))}
			{hosts.length > 0 ? <DefaultComputer hosts={hosts} computer={computer} onChoose={(key) => onChange(hosts, key)} /> : null}
			{ready.map(({ peer }) => (
				<PeerRow key={peer.dnsName} peer={peer} busy={adding.state === "checking"} onAdd={(pairingCode) => add(peer.dnsName, pairingCode)} />
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
