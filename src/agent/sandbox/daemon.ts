import { sha256Hex } from "../../encoding.ts";

export const DAEMON_OSES = ["darwin", "linux", "windows"] as const;
export type DaemonOs = (typeof DAEMON_OSES)[number];
export type DaemonArch = "x64" | "arm64";

export const OS_NAMES: Record<DaemonOs, string> = { darwin: "macOS", linux: "Linux", windows: "Windows" };

export interface Daemon {
	sha: string;
	bytes(): Promise<Uint8Array<ArrayBuffer>>;
}

const loads = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

export function daemon(os: DaemonOs, arch: DaemonArch): Daemon {
	const name = `${os}-${arch}`;
	const sha = __PI_ENV_DAEMONS__[name];
	if (!sha) throw new Error(`app 沒有附 ${name} 的 pi-env`);
	return {
		sha,
		bytes: () => {
			const loading =
				loads.get(name) ??
				(async () => {
					const response = await fetch(`/pi-env/${name}.bin.gzip`);
					if (!response.ok || !response.body) throw new Error(`讀不到 app 裡 ${name} 的 pi-env（HTTP ${response.status}）`);
					const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
					if ((await sha256Hex(bytes)) !== sha) throw new Error(`app 裡 ${name} 的 pi-env 跟建置時不一樣，不會上傳`);
					return bytes;
				})().finally(() => loads.delete(name));
			loads.set(name, loading);
			return loading;
		},
	};
}
