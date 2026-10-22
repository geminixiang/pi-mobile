// Settings › 電腦: the user's computers running pi-host on the tailnet (agent/sandbox/host.ts). Adding one is its name:
// the app asks pi-host about it, and pi-host answers only a phone of the same Tailscale user. When it does not answer,
// the one command that installs pi-host there is shown.
import { useState } from "react";
import { type Host, hostFrom, parseHosts, probeHost } from "../agent/sandbox/host.ts";
import { Copyable } from "./MachinesGroup.tsx";

export const INSTALL_HOST = "curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh";

function label(host: Host): string {
	return `${host.os === "darwin" ? "macOS" : "Linux"} · ${host.user}`;
}

type Adding = { state: "idle" } | { state: "checking" } | { state: "error"; detail: string };

export function HostsGroup({
	value,
	chosen,
	onChange,
}: {
	value: string;
	/** The default computer's id (settings.sandboxMachine). */
	chosen: string;
	onChange: (hosts: Host[], chosen: string) => void;
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
				const host = hostFrom(name, info, known?.id);
				const next = known ? hosts.map((item) => (item.id === known.id ? host : item)) : [...hosts, host];
				// The first computer becomes the default.
				onChange(next, chosen || (hosts.length === 0 ? host.id : chosen));
				setAddress("");
				setAdding({ state: "idle" });
			},
			(error: unknown) => setAdding({ state: "error", detail: error instanceof Error ? error.message : String(error) }),
		);
	};
	return (
		<>
			{hosts.map((host) => (
				<div className="machine" key={host.id}>
					<div className="check-row">
						<span className="menu-text">
							{host.name}
							<span className="menu-hint">{label(host)}</span>
						</span>
						<button type="button" className="toggle" aria-pressed={host.id === chosen} onClick={() => onChange(hosts, host.id === chosen ? "" : host.id)}>
							預設
						</button>
						<button type="button" className="btn" onClick={() => onChange(hosts.filter((item) => item.id !== host.id), host.id === chosen ? "" : chosen)}>
							移除
						</button>
					</div>
				</div>
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
