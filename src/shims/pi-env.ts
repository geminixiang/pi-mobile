// App entry for @earendil-works/pi-env: only the remote environment and its protocol types. The package index also
// exports the SSH deployment (Node child processes and files), which the app neither needs nor can bundle.
export { RemoteError } from "../../node_modules/@earendil-works/pi-env/dist/connection.js";
export { RemoteExecutionEnv } from "../../node_modules/@earendil-works/pi-env/dist/remote-env.js";
