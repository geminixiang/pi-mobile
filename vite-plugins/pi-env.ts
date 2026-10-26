import type { Plugin } from "vite";

const CONNECTION = /node_modules\/@earendil-works\/pi-env\/dist\/connection\.js$/;
const NODE_TIMER_UNREF = "session.timer.unref();";

export function patchPiEnvConnection(source: string): string {
	if (!source.includes(NODE_TIMER_UNREF)) throw new Error(`pi-env's Connection no longer calls ${NODE_TIMER_UNREF}; recheck vite-plugins/pi-env.ts, the WebView's setInterval returns a number without unref`);
	return source.replace(NODE_TIMER_UNREF, "");
}

export function piEnvInWebView(): Plugin {
	return {
		name: "pi-env-in-webview",
		enforce: "pre",
		transform(code, id) {
			return CONNECTION.test(id) ? patchPiEnvConnection(code) : undefined;
		},
	};
}
