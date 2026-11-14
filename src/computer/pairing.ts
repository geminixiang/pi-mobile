import { type Static, Type } from "typebox";
import { decodeEach, decode, oneOf } from "../parse.ts";
import { onTailnet, refuseIpOnIos, tailscaleHint } from "../agent/cleartext.ts";
import { ios } from "../native.ts";

export const DAEMON_OSES = ["darwin", "linux", "windows"] as const;
export type DaemonOs = (typeof DAEMON_OSES)[number];
export type DaemonArch = "x64" | "arm64";

export const OS_NAMES: Record<DaemonOs, string> = { darwin: "macOS", linux: "Linux", windows: "Windows" };

const HOST_PORT = 4790;

const System = {
	os: oneOf(DAEMON_OSES),
	arch: oneOf(["x64", "arm64"]),
};

const HostInfo = Type.Object({
	version: Type.String(),
	...System,
	user: Type.String(),
	home: Type.String(),
	name: Type.String(),
	dnsName: Type.String(),
	daemons: Type.Array(Type.String()),
	engines: Type.Array(Type.String()),
});
type HostInfo = Static<typeof HostInfo>;

const Host = Type.Object({
	id: Type.String(),
	name: Type.String(),
	address: Type.String(),
	...System,
	user: Type.String(),
	home: Type.String(),
	engine: Type.Optional(Type.String()),
});
export type Host = Static<typeof Host>;

export type PairedHost = Host & { key: string };
export type Reach = Pick<PairedHost, "address" | "key">;

export function pairedHosts(settings: { hosts: readonly Host[]; hostKeys: Record<string, string> }): PairedHost[] {
	return settings.hosts.map((host) => ({ ...host, key: settings.hostKeys[host.id] ?? "" }));
}

export type HostMode = "direct" | "container";

export const computerKey = (hostId: string, mode: HostMode) => `${hostId}:${mode}`;

export function parseComputerKey(key: string): { hostId: string; mode: HostMode } | undefined {
	const at = key.lastIndexOf(":");
	const mode = key.slice(at + 1);
	return at > 0 && (mode === "direct" || mode === "container") ? { hostId: key.slice(0, at), mode } : undefined;
}

export function parseHosts(json: string | undefined): Host[] {
	return decodeEach(Host, json);
}

function base(address: string): string {
	const root = `http://${address.includes(":") ? `[${address}]` : address}:${HOST_PORT}`;
	if (!onTailnet(root)) throw new Error(`${address} 不在 Tailscale 裡：填電腦在 Tailscale 裡的名稱，例如 mac 或 mac.xxxx.ts.net`);
	refuseIpOnIos(root, ios);
	return root;
}

// why: a WebSocket from the WebView cannot carry headers, so the pairing key rides in the query on every request alike.
export function url(reach: Reach, path: string, params: Record<string, string> = {}): URL {
	const target = new URL(path, base(reach.address));
	for (const [key, value] of Object.entries({ ...params, key: reach.key })) target.searchParams.set(key, value);
	return target;
}

export function socketUrl(reach: Reach, path: string, params: Record<string, string>): URL {
	const target = url(reach, path, params);
	target.protocol = "ws:";
	return target;
}

async function reached(address: string, request: Promise<Response>): Promise<Response> {
	const response = await request.then(
		(ok) => ok,
		() => {
			throw new Error(`連不到 ${address}：電腦要開著、連上 Tailscale，並裝好 pi-mobile${tailscaleHint(ios)}`);
		},
	);
	if (response.status === 401) throw new Error(`${address} 沒有跟這支手機配對：在那台電腦執行 pi-mobile pair，把配對碼輸入設定 › 電腦`);
	if (response.status === 403) throw new Error(`${address} 拒絕了這支手機：手機和電腦要登入同一個 Tailscale 帳號`);
	return response;
}

const PairAnswer = Type.Object({ key: Type.String() });

export async function pairHost(address: string, code: string): Promise<string> {
	const response = await reached(address, fetch(`${base(address)}/pair?code=${encodeURIComponent(code)}`, { method: "POST", signal: AbortSignal.timeout(15_000) }));
	if (response.status === 410) throw new Error(`${address} 沒有等待中的配對碼：在那台電腦執行 pi-mobile pair`);
	if (response.status === 422) throw new Error("配對碼不對；錯 5 次要在電腦上重新執行 pi-mobile pair");
	if (!response.ok) throw new Error(`${address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const answer = decode(PairAnswer, await response.text());
	if (!answer) throw new Error(`${address} 的回應看不懂，電腦上的 pi-mobile 可能要更新`);
	return answer.key;
}

export async function unpairHost(host: Reach): Promise<void> {
	const response = await reached(host.address, fetch(url(host, "/unpair"), { method: "DELETE", signal: AbortSignal.timeout(8000) }));
	if (response.status === 204) return;
	const body = (await response.text()).trim();
	if (response.status === 404 && body.includes("not paired")) return;
	if (response.status === 404 || response.status === 405) throw new Error(`${host.address} 上的 pi-mobile 太舊，不會撤銷配對：更新它之後執行 pi-mobile pair 重新配對，或刪掉 ~/.pi/mobile/paired.json`);
	throw new Error(`${host.address} 回應 HTTP ${response.status}：${body}`);
}

export async function stillPaired(reach: Reach, signal: AbortSignal): Promise<boolean> {
	const response = await fetch(url(reach, "/info"), { signal });
	return response.status !== 401;
}

export async function hasPiMobile(address: string, signal: AbortSignal): Promise<boolean> {
	return fetch(`${base(address)}/version`, { signal }).then(
		(response) => response.ok,
		() => false,
	);
}

export async function probeHost(reach: Reach, signal?: AbortSignal): Promise<HostInfo> {
	const response = await reached(reach.address, fetch(url(reach, "/info"), { signal: signal ?? AbortSignal.timeout(15_000) }));
	if (!response.ok) throw new Error(`${reach.address} 回應 HTTP ${response.status}：${(await response.text()).trim()}`);
	const info = decode(HostInfo, await response.text());
	if (!info) throw new Error(`${reach.address} 的回應看不懂，電腦上的 pi-mobile 可能要更新`);
	return info;
}

export function hostFrom(address: string, info: HostInfo, known?: Host): Host {
	const engine = info.engines[0];
	return {
		id: known?.id ?? (info.dnsName || address),
		name: info.name,
		address: info.dnsName || address,
		os: info.os,
		arch: info.arch,
		user: info.user,
		home: info.home,
		...(engine ? { engine } : {}),
	};
}

const Peer = Type.Object({ name: Type.String(), dnsName: Type.String(), os: System.os });
export type Peer = Static<typeof Peer>;

export async function listPeers(host: Reach): Promise<Peer[]> {
	const response = await fetch(url(host, "/peers"), { signal: AbortSignal.timeout(8000) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return decodeEach(Peer, await response.text());
}

