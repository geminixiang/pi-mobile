# Sandbox over SSH

Status: phases 1 and 2 done (machines over SSH, trusted and container modes, egress through bridge.py); the relay still
works for hosts paired by QR code.

## Problem

Today a sandbox host needs `sandbox/install.sh`: Node 22, Docker (colima on macOS), images built on the host, and a
relay service listening on the tailnet (port 8787) that the phone pairs with by QR code. Most of the owner's machines
have none of that: of five Linux machines on the tailnet, one has Docker and none has Node. `deploy.sh` also ships only
the linux-arm64 daemon, so x86-64 hosts cannot be used at all.

pi-env was built for the other way: `connectSsh` detects the remote system, uploads its daemon (named by SHA-256 and
verified before every start), and talks to it over the ssh process's stdin and stdout. Other pi-env users do exactly
this (pi-phone's Machines, bill-llmbergh, telepi) or replace the ssh command with `<engine> exec -i` (mikan, oqto). The
app cannot use `connectSsh` because the WebView cannot spawn `ssh`.

## Goal

Pick a machine, accept its host key, tap "安裝並連線", and its tools are the conversation's tools. Nothing to install on
the machine beyond an SSH server; a container runtime if the owner wants isolation.

Keep what the relay design does well: credentials never enter a sandbox, and every write through them is approved on
the phone.

## Design

### Transport: SSH from the phone

A native `Ssh` plugin (ConnectBot's `sshlib`: pure Java, made for Android, Ed25519 through Tink) holds connections.
The JS side sees byte streams:

- `connect({ host, port, user, hostKey })` → `{ connection }`; refuses a host key other than the accepted one.
- `scanHostKey({ host, port })` → `{ algorithm, key, fingerprint }` (SHA-256, as `ssh-keygen -l` prints it).
- `exec({ connection, command })` → `{ channel }`; events `data` (base64 stdout/stderr) and `exit`; `write`, `eof`,
  `close`.
- `publicKey()` → the app's own key (`ssh-ed25519 …`), generated once, kept in the app's private storage. Nothing of
  the owner's `~/.ssh` is involved.

`src/agent/sandbox/ws-connection.ts` already ports pi-env's `Connection` to a WebSocket. Its framing and session logic
move behind a small `Transport` (open a stream, write, end, on data, on close), with two implementations: WebSocket to
the relay, and an SSH exec channel.

### Deployment

On "安裝並連線" (never on the agent's behalf), over one exec channel:

1. Probe: `uname -sm`, `$HOME`, which container engines answer (`nerdctl`, `podman`, `docker`, like mikan), and
   whether `~/.pi/env/<sha256>/pi-env` exists.
2. Upload the daemon for that system if missing: `cat > tmp`, check its SHA-256, `chmod +x`, `mv`. The APK carries the
   linux and darwin daemons for x86-64 and arm64 from `@earendil-works/pi-env` (about 8 MB).
3. Start it once (`pi-env --version`) and record the system, engine, and daemon version on the machine entry.

A machine not connected yet refuses sessions with a message that says so; the agent can never trigger deployment.

### Modes

- **Container** (default when an engine answers): one container per conversation, `<engine> exec -i <container>
  pi-env serve`, the daemon copied in once. Same limits and idle stop as the relay does today, done by the phone over
  SSH instead of a resident relay.
- **Trusted** (no engine, or chosen): the daemon runs as the SSH user in `~/pi-workspaces/<conversation>`. The app
  says plainly that the agent uses the machine's own sign-ins there and its writes are not approved on the phone, and
  suggests a dedicated user account.

### Credentials

The egress proxy stays a container on the host (`pi-mobile-egress`, on the `pi-mobile` network). Instead of asking the
relay over HTTP, it asks `sandbox/egress/bridge.py`, which the phone runs in the proxy's container with
`<engine> exec -i` over its SSH connection: each `/egress/authorize` goes to the phone as a JSON line and the answer
(a token, or a reason) comes back on stdin. The bridge also serves az's managed identity endpoint with placeholders.
An exec channel rather than an SSH remote forward, because a forward binds the host's loopback, which containers
cannot reach without GatewayPorts. When the phone goes away the channel closes and the bridge exits, so the proxy
refuses at once, with no grace period.

### Relay

Kept for hosts already paired by QR code until SSH covers credentials; then removed together with `install.sh`.

## Phases

1. Done: SSH plugin, transport refactor, machines in Settings (add, accept key, install and connect), trusted mode.
2. Done: container mode with engine detection, images built on the host (labeled with their files' hash), egress
   through bridge.py.
3. Next: images from GHCR (multi-arch) so the first install skips the build; then drop the relay and install.sh.
