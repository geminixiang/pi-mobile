import assert from "node:assert/strict";
import { refuseIpOnIos } from "../../src/agent/cleartext.ts";
import { fetchModelIds } from "../../src/agent/models.ts";
import { pairHost } from "../../src/agent/sandbox/host.ts";
import { type Check } from "./setup.ts";

const refused = /不透過明文 HTTP/;
const offline = /contracts run offline/;

export const checks: Check[] = [
	[
		"a key never goes over plain HTTP outside Tailscale and this device",
		async () => {
			for (const url of ["http://192.168.1.20:8317", "http://example.com", "http://10.0.2.2:8317", "http://100.128.0.1:8317", "http://evil.ts.net.example.com"]) {
				await assert.rejects(fetchModelIds(url, "secret"), refused, url);
			}
			for (const url of ["https://api.example.com", "http://localhost:8317", "http://127.0.0.1:8317", "http://[::1]:8317", "http://100.64.0.1:8317", "http://mac.tailnet.ts.net:8317", "http://[fd7a:115c:a1e0::1]:8317"]) {
				await assert.rejects(fetchModelIds(url, "secret"), (error) => !refused.test(String(error)), url);
			}
			await assert.rejects(fetchModelIds("http://192.168.1.20:11434", ""), offline, "a keyless server on the LAN is still reachable");
		},
	],
	[
		"the pairing code, the key and every command go only to a computer in the tailnet",
		async () => {
			for (const address of ["192.168.1.20", "mac.local", "example.com", "localhost", "127.0.0.1", "100.128.0.1", "mac.ts.net.example.com"]) {
				await assert.rejects(pairHost(address, "123456"), /不在 Tailscale 裡/, address);
			}
			for (const address of ["mac", "mac.tailnet.ts.net", "100.64.0.1", "fd7a:115c:a1e0::1"]) {
				await assert.rejects(pairHost(address, "123456"), /連不到/, address);
			}
		},
	],
	[
		"a gateway in the tailnet that does not answer is reported as Tailscale being off, not as a failed load",
		async () => {
			for (const url of ["https://mac.tailnet.ts.net:8318", "http://100.64.0.1:8317"]) {
				await assert.rejects(fetchModelIds(url, "secret"), /連不到 .*Tailscale 要連著/, url);
			}
			await assert.rejects(fetchModelIds("http://mac:8317", ""), /連不到 mac:8317：Tailscale 要連著/, "a short MagicDNS name");
			for (const url of ["https://api.example.com", "http://localhost:8317"]) await assert.rejects(fetchModelIds(url, "secret"), offline, url);
		},
	],
	[
		"on iOS a plain HTTP address is a Tailscale name, which ATS lets through, not an IP, which it blocks",
		async () => {
			for (const url of ["http://100.64.0.1:8317", "ws://100.64.0.1:4790/exec", "http://[fd7a:115c:a1e0::1]:4790", "http://192.168.1.20:11434"]) {
				assert.throws(() => refuseIpOnIos(url, true), /Tailscale 名稱/, url);
				assert.doesNotThrow(() => refuseIpOnIos(url, false), url);
			}
			for (const url of ["http://mac.tailnet.ts.net:8317", "http://mac:4790", "http://localhost:8317", "http://127.0.0.1:8317", "https://100.64.0.1"]) {
				assert.doesNotThrow(() => refuseIpOnIos(url, true), url);
			}
		},
	],
];
