// Settings › 機器: the user's machines over SSH (docs/design/sandbox-ssh.md). Adding one reads its host key for the
// user to compare and accept; the app's public key goes into the machine's authorized_keys by the user's hand; then
// "安裝並連線" deploys pi-env there. Only a machine the user connected can be chosen for the agent's tools.
import { type ReactNode, useState } from "react";
import { type ConnectStep, installOn, type Machine, parseMachines } from "../agent/sandbox/machine.ts";
import { appPublicKey, type HostKey, scanHostKey } from "../agent/sandbox/ssh.ts";

const STEPS: Record<ConnectStep, string> = {
	connect: "連線中",
	probe: "查看系統",
	upload: "上傳 pi-env",
	verify: "確認可以執行",
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function systemLabel(machine: Machine): string {
	const system = machine.system;
	if (!system) return "還沒連線";
	return `${system.os === "darwin" ? "macOS" : "Linux"} ${system.arch} · 已連線`;
}

function Copyable({ text, children }: { text: string; children?: ReactNode }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="copyable">
			<pre className="console">{children ?? text}</pre>
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
	);
}

type Draft = { name: string; host: string; port: string; user: string };
type Adding = { state: "form" } | { state: "scanning" } | { state: "key"; hostKey: HostKey } | { state: "error"; detail: string };

function AddMachine({ onAdd, onCancel }: { onAdd: (machine: Machine) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState<Draft>({ name: "", host: "", port: "22", user: "" });
	const [adding, setAdding] = useState<Adding>({ state: "form" });
	const port = Number(draft.port);
	const valid = draft.host.length > 0 && draft.user.length > 0 && Number.isInteger(port) && port > 0 && port < 65536;
	const input = (key: keyof Draft) => ({
		value: draft[key],
		onChange: (event: { target: { value: string } }) => {
			setDraft({ ...draft, [key]: event.target.value.trim() });
			setAdding({ state: "form" });
		},
	});
	return (
		<div className="machine-add">
			<label>
				<span>主機</span>
				<input {...input("host")} placeholder="clanker-001 或 100.x.y.z" autoCapitalize="off" autoComplete="off" />
			</label>
			<label>
				<span>帳號</span>
				<input {...input("user")} placeholder="pi" autoCapitalize="off" autoComplete="off" />
			</label>
			<label>
				<span>Port</span>
				<input {...input("port")} inputMode="numeric" />
			</label>
			<label>
				<span>名稱</span>
				<input {...input("name")} placeholder={draft.host || "選填"} autoComplete="off" />
			</label>
			{adding.state === "key" ? (
				<div className="pair-steps">
					<p>這台主機的金鑰指紋是：</p>
					<pre className="console">{adding.hostKey.fingerprint}</pre>
					<p>
						在那台機器上執行 <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> 比對，一樣才接受。之後金鑰改變，app 會拒絕連線。
					</p>
					<div className="row-buttons">
						<button type="button" className="btn" onClick={onCancel}>
							取消
						</button>
						<button
							type="button"
							className="btn primary"
							onClick={() =>
								onAdd({
									id: crypto.randomUUID(),
									name: draft.name || draft.host,
									host: draft.host,
									port,
									user: draft.user,
									hostKey: adding.hostKey.key,
									fingerprint: adding.hostKey.fingerprint,
								})
							}
						>
							接受
						</button>
					</div>
				</div>
			) : (
				<div className="row-buttons">
					<button type="button" className="btn" onClick={onCancel}>
						取消
					</button>
					<button
						type="button"
						className="btn primary"
						disabled={!valid || adding.state === "scanning"}
						onClick={() => {
							setAdding({ state: "scanning" });
							scanHostKey(draft.host, port).then(
								(hostKey) => setAdding({ state: "key", hostKey }),
								(error: unknown) => setAdding({ state: "error", detail: errorText(error) }),
							);
						}}
					>
						{adding.state === "scanning" ? "讀取中…" : "讀取主機金鑰"}
					</button>
				</div>
			)}
			{adding.state === "error" ? <span className="check-error">{adding.detail}</span> : null}
		</div>
	);
}

type Install = { state: "idle" } | { state: "running"; step: ConnectStep } | { state: "error"; detail: string };

function MachineRow({
	machine,
	chosen,
	onChoose,
	onChange,
	onRemove,
}: {
	machine: Machine;
	chosen: boolean;
	onChoose: (on: boolean) => void;
	onChange: (machine: Machine) => void;
	onRemove: () => void;
}) {
	const [install, setInstall] = useState<Install>({ state: "idle" });
	const [publicKey, setPublicKey] = useState<string>();
	const run = () => {
		setInstall({ state: "running", step: "connect" });
		installOn(machine, (step) => setInstall({ state: "running", step })).then(
			(system) => {
				setInstall({ state: "idle" });
				onChange({ ...machine, system });
			},
			(error: unknown) => {
				const detail = errorText(error);
				setInstall({ state: "error", detail });
				// A refused key needs the app's public key on the machine: show it right there.
				if (detail.includes("authorized_keys")) void appPublicKey().then(setPublicKey);
			},
		);
	};
	return (
		<div className="machine">
			<div className="check-row">
				<span className="menu-text">
					{machine.name}
					<span className="menu-hint">
						{machine.user}@{machine.host}
						{machine.port === 22 ? "" : `:${machine.port}`} · {systemLabel(machine)}
					</span>
				</span>
				<button type="button" className="toggle" aria-pressed={chosen} disabled={!machine.system} onClick={() => onChoose(!chosen)}>
					使用
				</button>
			</div>
			{chosen ? (
				<p className="hint machine-note">
					agent 會直接在這台機器上以 {machine.user} 的身分工作，每個對話一個資料夾（~/pi-workspaces）。它用的是這台機器自己的登入（git、gh、雲端
					CLI），寫入不會經過手機核准；建議用專門給 agent 的帳號。
				</p>
			) : null}
			<div className="row-buttons">
				<button type="button" className="btn" onClick={onRemove} disabled={install.state === "running"}>
					移除
				</button>
				<button type="button" className="btn" onClick={run} disabled={install.state === "running"}>
					{install.state === "running" ? `${STEPS[install.step]}…` : machine.system ? "重新安裝" : "安裝並連線"}
				</button>
			</div>
			{install.state === "error" ? <span className="check-error">{install.detail}</span> : null}
			{publicKey ? (
				<div className="pair-steps">
					<p>在 {machine.name} 上以 {machine.user} 執行這行，把 app 的公鑰加進去，再按一次「安裝並連線」：</p>
					<Copyable text={`mkdir -p ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys`} />
				</div>
			) : null}
		</div>
	);
}

/** The machines list; `value` and `chosen` are the settings' JSON and the chosen machine's id. */
export function MachinesGroup({
	value,
	chosen,
	onChange,
}: {
	value: string;
	chosen: string;
	onChange: (machines: string, chosen: string) => void;
}) {
	const machines = parseMachines(value);
	const [adding, setAdding] = useState(false);
	const [publicKey, setPublicKey] = useState<string>();
	const save = (next: Machine[], nextChosen = chosen) =>
		onChange(JSON.stringify(next), next.some((machine) => machine.id === nextChosen) ? nextChosen : "");
	return (
		<>
			{machines.map((machine) => (
				<MachineRow
					key={machine.id}
					machine={machine}
					chosen={machine.id === chosen}
					onChoose={(on) => save(machines, on ? machine.id : "")}
					onChange={(next) => save(machines.map((candidate) => (candidate.id === next.id ? next : candidate)))}
					onRemove={() => save(machines.filter((candidate) => candidate.id !== machine.id))}
				/>
			))}
			{adding ? (
				<AddMachine
					onCancel={() => setAdding(false)}
					onAdd={(machine) => {
						setAdding(false);
						save([...machines, machine]);
						void appPublicKey().then(setPublicKey);
					}}
				/>
			) : (
				<button type="button" className="btn" onClick={() => setAdding(true)}>
					新增機器
				</button>
			)}
			{publicKey ? (
				<div className="pair-steps">
					<p>接著在那台機器上把 app 的公鑰加進 authorized_keys，再按「安裝並連線」：</p>
					<Copyable text={`mkdir -p ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys`} />
				</div>
			) : null}
		</>
	);
}
