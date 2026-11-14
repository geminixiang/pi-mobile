import assert from "node:assert/strict";
import { type CommandChannel, type CommandClient, type CommandHandlers, ContainerHost } from "../../src/agent/sandbox/container.ts";
import { sleep } from "../../src/promise.ts";
import type { Check } from "./setup.ts";

const CERT = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";

function engine(openMs: number) {
	const bridges: { closed: boolean; handlers: CommandHandlers }[] = [];
	const client: CommandClient = {
		run: async (command) => {
			if (command.includes("image inspect")) return { stdout: "sha256:egress\n", stderr: "", code: 0 };
			if (command.includes("network inspect")) return { stdout: "pi-mobile\n", stderr: "", code: 0 };
			if (command.includes("inspect -f")) return { stdout: "sha256:egress true\n", stderr: "", code: 0 };
			if (command.includes("mitmproxy-ca-cert.pem")) return { stdout: CERT, stderr: "", code: 0 };
			return { stdout: "", stderr: "", code: 0 };
		},
		exec: async (command, handlers): Promise<CommandChannel> => {
			if (!command.includes("bridge.py")) {
				setTimeout(() => handlers.onExit(0), 0);
				return { write: () => undefined, end: () => undefined, close: () => undefined };
			}
			const bridge = { closed: false, handlers };
			bridges.push(bridge);
			await sleep(openMs);
			return {
				write: () => undefined,
				end: () => undefined,
				close: () => {
					bridge.closed = true;
					handlers.onExit(undefined);
				},
			};
		},
	};
	return { host: new ContainerHost("docker", client, "/home/fixture"), bridges };
}

export const checks: Check[] = [
	[
		"stopping the credentials bridge while it is still starting leaves no bridge running",
		async () => {
			const { host, bridges } = engine(100);
			const stop = host.bridge({ minted: {} });
			for (let waited = 0; waited < 2000 && bridges.length === 0; waited += 5) await sleep(5);
			stop();
			await sleep(300);
			assert.ok(bridges.length > 0, "the bridge never started, so this check proves nothing");
			assert.ok(bridges.every((bridge) => bridge.closed), `bridges still running after stop: ${bridges.filter((bridge) => !bridge.closed).length} of ${bridges.length}`);
		},
	],
	[
		"stopping the bridge before the egress proxy is ready starts no bridge at all",
		async () => {
			const { host, bridges } = engine(0);
			const stop = host.bridge({ minted: {} });
			stop();
			await sleep(300);
			assert.equal(bridges.filter((bridge) => !bridge.closed).length, 0, `a bridge started after stop and is still running (${bridges.length} started)`);
		},
	],
];
