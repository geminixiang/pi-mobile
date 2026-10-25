import assert from "node:assert/strict";
import { fetchModelIds } from "../../src/agent/models.ts";
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
				await assert.rejects(fetchModelIds(url, "secret"), offline, url);
			}
			await assert.rejects(fetchModelIds("http://192.168.1.20:11434", ""), offline, "a keyless server on the LAN is still reachable");
		},
	],
];
