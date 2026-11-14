import { useEffect, useState } from "react";
import { computerKey, hasPiMobile, hostFrom, listPeers, OS_NAMES, type PairedHost, pairHost, type Peer, parseComputerKey, probeHost, stillPaired, unpairHost } from "../computer/pairing.ts";
import { prepareContainers, watchPrepare } from "../agent/sandbox/host.ts";
import { Apps } from "../plugins/apps.ts";
import { messageOf, orLogged } from "../promise.ts";
import { CopyButton } from "./CopyButton.tsx";
import { ShareIcon, TerminalIcon } from "./icons.tsx";
import { ChoiceRow } from "./ChoiceRow.tsx";
import { RowList } from "./RowList.tsx";
import { Sheet } from "./Sheet.tsx";

const MANUAL = "manual";

const INSTALLS = [
	{ where: "Mac、Linux 在終端機執行：", command: "curl -fsSL https://github.com/geminixiang/pi-mobile/releases/latest/download/install.sh | sh" },
	{ where: "Windows 在 PowerShell 執行：", command: "iex ([Text.Encoding]::UTF8.GetString((iwr -useb https://github.com/geminixiang/pi-mobile/releases/latest/download/install.ps1).Content))" },
];

type Preparing = { state: "idle" } | { state: "running"; detail: string } | { state: "error"; detail: string };

export function usePrepare(host: PairedHost | undefined): [Preparing, (target: PairedHost) => Promise<boolean>] {
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
	const prepare = (target: PairedHost) => {
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

function PairRow({ label, primary, busy, onPair }: { label: string; primary: boolean; busy: boolean; onPair: (code: string) => void }) {
	const [code, setCode] = useState("");
	return (
		<div className="check-row pair-row">
			<CodeField value={code} onChange={setCode} onEnter={() => onPair(code)} />
			<button type="button" className={primary ? "btn primary" : "btn"} disabled={code.length !== 6 || busy} onClick={() => onPair(code)}>
				{label}
			</button>
		</div>
	);
}

function useUnpaired(host: PairedHost): boolean {
	const [unpaired, setUnpaired] = useState(false);
	useEffect(() => {
		if (!host.key) return undefined;
		let current = true;
		void orLogged(stillPaired(host, AbortSignal.timeout(5000)), "hosts.pairing_unknown", undefined, { host: host.address }).then((paired) => current && setUnpaired(paired === false));
		return () => {
			current = false;
		};
	}, [host.address, host.key]);
	return unpaired;
}

function HostSheet({ host, busy, onPair, onRemove, onClose }: { host: PairedHost | undefined; busy: boolean; onPair: (code: string) => void; onRemove: () => void; onClose: () => void }) {
	return (
		<Sheet open={host !== undefined} title={host?.name ?? ""} onClose={onClose}>
			{host ? (
				<div className="sheet-form">
					<PairRow label="重新配對" primary busy={busy} onPair={onPair} />
					<button type="button" className="danger-verb" onClick={onRemove}>
						移除
					</button>
				</div>
			) : null}
		</Sheet>
	);
}

function HostRow({ host, onOpen }: { host: PairedHost; onOpen: () => void }) {
	const unpaired = useUnpaired(host);
	const paired = Boolean(host.key) && !unpaired;
	return (
		<button type="button" onClick={onOpen}>
			<TerminalIcon size={18} />
			<span className="menu-text">
				{host.name}
				<span className="index-status">{paired ? `${OS_NAMES[host.os]} · ${host.user}` : "要重新配對"}</span>
			</span>
			<i className={`row-dot${paired ? "" : " off"}`} />
		</button>
	);
}

function DefaultComputer({ hosts, computer, onChoose }: { hosts: PairedHost[]; computer: string; onChoose: (key: string) => void }) {
	const [preparing, prepare] = usePrepare(undefined);
	const choose = (key: string) => {
		const chosen = parseComputerKey(key);
		const host = hosts.find((item) => item.id === chosen?.hostId);
		if (chosen?.mode !== "container" || !host) return onChoose(key);
		void prepare(host).then((ready) => ready && onChoose(key));
	};
	return (
		<RowList title="新 Bot 在哪裡跑">
			<ChoiceRow
				label="預設"
				value={computer}
				choices={[
					{ value: "", label: "手機" },
					...hosts.flatMap((host) => [
						{ value: computerKey(host.id, "direct"), label: `${host.name} · 直接` },
						...(host.engine ? [{ value: computerKey(host.id, "container"), label: `${host.name} · 容器` }] : []),
					]),
				]}
				onChoose={choose}
			/>
			{preparing.state === "idle" ? null : (
				<p className="row-empty">
					<PrepareStatus preparing={preparing} />
				</p>
			)}
		</RowList>
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
	const [open, setOpen] = useState<string>();
	const add = (name: string, pairingCode: string) => {
		setAdding({ state: "checking" });
		void (async () => {
			const key = await pairHost(name, pairingCode);
			const info = await probeHost({ address: name, key });
			const known = hosts.find((host) => host.address === (info.dnsName || name));
			const host: PairedHost = { ...hostFrom(name, info, known), key };
			const next = known ? hosts.map((item) => (item.id === known.id ? host : item)) : [...hosts, host];
			onChange(next, computer);
			setAddress("");
			setCode("");
			setAdding({ state: "idle" });
		})().catch((error: unknown) => setAdding({ state: "error", detail: messageOf(error) }));
	};
	const ready = found?.filter((item) => item.installed) ?? [];
	const missing = found?.filter((item) => !item.installed) ?? [];
	const busy = adding.state === "checking";
	const opened = hosts.find((host) => host.id === open);
	const joining = ready.find((item) => item.peer.dnsName === open);
	return (
		<>
			<RowList title="電腦">
				{hosts.map((host) => (
					<HostRow key={host.id} host={host} onOpen={() => setOpen(host.id)} />
				))}
				<button type="button" className="row-add" onClick={() => setOpen(MANUAL)}>
					＋ 手動加入
				</button>
				{adding.state === "error" ? <p className="row-empty error">{adding.detail}</p> : null}
			</RowList>
			{ready.length > 0 ? (
				<RowList title="Tailscale 上找到">
					{ready.map(({ peer }) => (
						<button type="button" key={peer.dnsName} onClick={() => setOpen(peer.dnsName)}>
							<TerminalIcon size={18} />
							<span className="menu-text">
								{peer.name}
								<span className="index-status">{OS_NAMES[peer.os]}</span>
							</span>
							<span className="row-value">加入</span>
						</button>
					))}
				</RowList>
			) : null}
			{hosts.length > 0 ? <DefaultComputer hosts={hosts} computer={computer} onChoose={(key) => onChange(hosts, key)} /> : null}
			{hosts.length === 0 ? (
				<div className="pair-steps">
					{missing.length > 0 ? <p>{`還沒裝 pi-mobile：${missing.map((item) => item.peer.name).join("、")}。`}</p> : null}
					{INSTALLS.map((install) => (
						<div key={install.where}>
							<p>{install.where}</p>
							<div className="copyable">
								<pre className="console">{install.command}</pre>
								<div className="row-buttons">
									<button
										type="button"
										className="icon-button small"
										aria-label="分享"
										onClick={() => void orLogged(Apps.share({ text: install.command, title: "在電腦上安裝 pi-mobile" }), "hosts.share_failed", undefined)}
									>
										<ShareIcon size={16} />
									</button>
									<CopyButton text={install.command} />
								</div>
							</div>
						</div>
					))}
				</div>
			) : null}
			<HostSheet
				host={opened}
				busy={busy}
				onClose={() => setOpen(undefined)}
				onPair={(pairingCode) => opened && add(opened.address, pairingCode)}
				onRemove={() => {
					if (!opened) return;
					setOpen(undefined);
					onChange(
						hosts.filter((item) => item.id !== opened.id),
						parseComputerKey(computer)?.hostId === opened.id ? "" : computer,
					);
					if (opened.key) void unpairHost(opened).catch((error: unknown) => setAdding({ state: "error", detail: `已從手機移除，但電腦上的配對還在：${messageOf(error)}` }));
				}}
			/>
			<Sheet open={joining !== undefined} title={joining?.peer.name ?? ""} onClose={() => setOpen(undefined)}>
				{joining ? (
					<div className="sheet-form">
						<PairRow label="加入" primary busy={busy} onPair={(pairingCode) => add(joining.peer.dnsName, pairingCode)} />
					</div>
				) : null}
			</Sheet>
			<Sheet open={open === MANUAL} title="手動加入" onClose={() => setOpen(undefined)}>
				<div className="sheet-form">
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
						<button type="button" className="btn primary" disabled={!address.trim() || code.length !== 6 || busy} onClick={() => add(address.trim(), code)}>
							{busy ? "連線中…" : "加入"}
						</button>
					</div>
					{adding.state === "error" ? <p className="row-empty error">{adding.detail}</p> : null}
				</div>
			</Sheet>
		</>
	);
}
