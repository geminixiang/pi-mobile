// Settings › 電腦: the user's computers running pi-host on the tailnet (agent/sandbox/host.ts). Adding one is its name:
// the app asks pi-host about it, and pi-host answers only a phone of the same Tailscale user. When it does not answer,
// the one command that installs pi-host there is shown. Each computer is a default for bots that have not picked:
// directly, or in its container, which the first tap prepares (builds the images there, minutes the first time).
import { type ReactNode, useState } from "react";
import { type Host, hostFrom, parseHosts, prepareContainers, probeHost } from "../agent/sandbox/host.ts";
import { Apps } from "../agent/tools/apps.ts";

export const INSTALL_HOST = "curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A command to run on the computer: copied, or shared to it (a chat, mail, notes synced there). */
function Copyable({ text, children }: { text: string; children?: ReactNode }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="copyable">
			<pre className="console">{children ?? text}</pre>
			<div className="row-buttons">
				<button type="button" className="btn" onClick={() => void Apps.share({ text, title: "安裝 pi-host" }).catch(() => undefined)}>
					分享
				</button>
				<button
				type="button"
				className="btn"
				onClick={() =>
					void navigator.clipboard.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
				}
			>
					{copied ? "已複製" : "複製"}
				</button>
			</div>
		</div>
	);
}

type Preparing = { state: "idle" } | { state: "running"; detail: string } | { state: "error"; detail: string };

function HostRow({
	host,
	computer,
	onChoose,
	onReady,
	onRemove,
}: {
	host: Host;
	/** The default computer key (settings.computer). */
	computer: string;
	onChoose: (key: string) => void;
	/** Its containers are ready: saved, and chosen as the default. */
	onReady: () => void;
	onRemove: () => void;
}) {
	const [preparing, setPreparing] = useState<Preparing>({ state: "idle" });
	const direct = `${host.id}:direct`;
	const container = `${host.id}:container`;
	const choose = (key: string) => onChoose(computer === key ? "" : key);
	const chooseContainer = () => {
		if (host.containersReady) return choose(container);
		setPreparing({ state: "running", detail: "檢查容器" });
		prepareContainers(host, (detail) => setPreparing({ state: "running", detail })).then(
			() => {
				setPreparing({ state: "idle" });
				onReady();
			},
			(error: unknown) => setPreparing({ state: "error", detail: errorText(error) }),
		);
	};
	return (
		<div className="machine">
			<div className="check-row">
				<span className="menu-text">
					{host.name}
					<span className="menu-hint">
						{host.os === "darwin" ? "macOS" : "Linux"} · {host.user}
					</span>
				</span>
				<button type="button" className="toggle" aria-pressed={computer === direct} onClick={() => choose(direct)}>
					直接
				</button>
				{host.engine ? (
					<button type="button" className="toggle" aria-pressed={computer === container} disabled={preparing.state === "running"} onClick={chooseContainer}>
						{preparing.state === "running" ? "準備中…" : "容器"}
					</button>
				) : null}
			</div>
			{computer === direct ? <p className="hint host-mode">用 {host.user} 的身分操作這台電腦，不會先問你</p> : null}
			{computer === container ? <p className="hint host-mode">在這台電腦的 Linux 容器裡，GitHub 和雲端的寫入先問你</p> : null}
			{preparing.state === "running" ? <span className="check-progress">{preparing.detail}</span> : null}
			{preparing.state === "error" ? <span className="check-error">{preparing.detail}</span> : null}
			<div className="row-buttons">
				<button type="button" className="btn" onClick={onRemove}>
					移除
				</button>
			</div>
		</div>
	);
}

type Adding = { state: "idle" } | { state: "checking" } | { state: "error"; detail: string };

export function HostsGroup({
	value,
	computer,
	onChange,
}: {
	value: string;
	computer: string;
	onChange: (hosts: Host[], computer: string) => void;
}) {
	const hosts = parseHosts(value);
	const [address, setAddress] = useState("");
	const [adding, setAdding] = useState<Adding>({ state: "idle" });
	const add = () => {
		const name = address.trim();
		if (!name) return;
		setAdding({ state: "checking" });
		probeHost(name).then(
			(info) => {
				const known = hosts.find((host) => host.address === (info.dnsName || name));
				const host = hostFrom(name, info, known);
				const next = known ? hosts.map((item) => (item.id === known.id ? host : item)) : [...hosts, host];
				// The first computer becomes the default, directly.
				onChange(next, computer || `${host.id}:direct`);
				setAddress("");
				setAdding({ state: "idle" });
			},
			(error: unknown) => setAdding({ state: "error", detail: errorText(error) }),
		);
	};
	return (
		<>
			{hosts.map((host) => (
				<HostRow
					key={host.id}
					host={host}
					computer={computer}
					onChoose={(key) => onChange(hosts, key)}
					onReady={() => onChange(hosts.map((item) => (item.id === host.id ? { ...item, containersReady: Date.now() } : item)), `${host.id}:container`)}
					onRemove={() => onChange(hosts.filter((item) => item.id !== host.id), computer.startsWith(`${host.id}:`) ? "" : computer)}
				/>
			))}
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
							if (event.key === "Enter") add();
						}}
						placeholder="Tailscale 裡的名稱或 IP"
						autoCapitalize="off"
						autoComplete="off"
						enterKeyHint="go"
					/>
				</label>
				<div className="row-buttons">
					<button type="button" className="btn primary" disabled={!address.trim() || adding.state === "checking"} onClick={add}>
						{adding.state === "checking" ? "連線中…" : "加入"}
					</button>
				</div>
				{adding.state === "error" ? (
					<>
						<span className="check-error">{adding.detail}</span>
						<div className="pair-steps">
							<p>還沒裝的話，在那台電腦的終端機執行：</p>
							<Copyable text={INSTALL_HOST} />
						</div>
					</>
				) : null}
			</div>
		</>
	);
}
