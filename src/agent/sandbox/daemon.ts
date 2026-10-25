
import { onFailure } from "../../promise.ts";export type DaemonOs = "darwin" | "linux";
export type DaemonArch = "x64" | "arm64";

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const ENV_PATH = 'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin"';

const daemons = new Map<string, Promise<{ bytes: Uint8Array; sha: string }>>();
export function daemon(os: DaemonOs, arch: DaemonArch): Promise<{ bytes: Uint8Array; sha: string }> {
	const name = `${os}-${arch}`;
	let pending = daemons.get(name);
	if (!pending) {
		pending = (async () => {
			const expected = __PI_ENV_DAEMONS__[name];
			if (!expected) throw new Error(`app 沒有附 ${name} 的 pi-env`);
			const response = await fetch(`/pi-env/${name}.bin.gzip`);
			if (!response.ok || !response.body) throw new Error(`讀不到 app 裡 ${name} 的 pi-env（HTTP ${response.status}）`);
			const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
			const sha = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
			if (sha !== expected) throw new Error(`app 裡 ${name} 的 pi-env 跟建置時不一樣，不會上傳`);
			return { bytes, sha };
		})();
		onFailure(pending, () => daemons.delete(name));
		daemons.set(name, pending);
	}
	return pending;
}
