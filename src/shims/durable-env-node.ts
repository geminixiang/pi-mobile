// Stand-in for @earendil-works/pi-durable/env/node, which pi-env imports for LocalExecutionEnv. The app only uses
// RemoteExecutionEnv; a local Node environment does not exist in the WebView.
export class NodeExecutionEnv {
	constructor() {
		throw new Error("NodeExecutionEnv is not available in the app");
	}
}
