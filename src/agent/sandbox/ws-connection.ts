// The sandbox relay's transport: a WebSocket to /env/<sandbox>, where the relay runs `pi-env serve` in the
// conversation's container and copies bytes both ways (sandbox/relay/server.js).
import { lost, type StreamConnectionOptions, StreamConnection } from "./stream-connection.ts";

export interface WebSocketConnectionOptions {
	/** Relay base URL, e.g. ws://100.x.y.z:8787 */
	relayUrl: string;
	relayToken: string;
	/** Sandbox (container) name: lowercase letters, digits, and dashes. */
	sandbox: string;
	onLog?: StreamConnectionOptions["onLog"];
}

export class WebSocketConnection extends StreamConnection {
	constructor(options: WebSocketConnectionOptions) {
		super({
			...(options.onLog ? { onLog: options.onLog } : {}),
			open: (token, handlers) => {
				const url = new URL(`/env/${encodeURIComponent(options.sandbox)}`, options.relayUrl);
				url.searchParams.set("token", options.relayToken);
				url.searchParams.set("daemonToken", token);
				const socket = new WebSocket(url);
				socket.binaryType = "arraybuffer";
				// Listen before `open` resolves: the daemon's first bytes can arrive in the same task as the open event.
				socket.addEventListener("message", (event) => {
					if (event.data instanceof ArrayBuffer) handlers.onData(new Uint8Array(event.data));
				});
				return new Promise((resolve, reject) => {
					socket.addEventListener(
						"open",
						() => {
							socket.addEventListener("close", (event) => handlers.onClose(event.reason || undefined));
							resolve({
								send: (data) => {
									if (socket.readyState === WebSocket.OPEN) socket.send(data);
								},
								close: () => {
									if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
								},
							});
						},
						{ once: true },
					);
					socket.addEventListener("error", () => reject(lost(`Cannot reach the sandbox relay at ${options.relayUrl}`)), { once: true });
				});
			},
		});
	}
}
