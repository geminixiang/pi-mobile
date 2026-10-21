"""Bridge between the egress proxy and the phone, for sandboxes reached over SSH (docs/design/sandbox-ssh.md).

The phone starts it with `<engine> exec -i pi-mobile-egress python3 /egress/bridge.py` over its SSH connection and
keeps that channel open while it is connected. It replaces the relay's two HTTP endpoints:

- 127.0.0.1:9001 POST /egress/authorize, called by credentials.py (RELAY_URL) for every intercepted request: each one
  goes to the phone as a JSON line on stdout, and the phone's answer (a token, or a reason) comes back on stdin.
- 0.0.0.0:9002 GET /azure/identity, az's managed identity endpoint for the sandboxes (IDENTITY_ENDPOINT): placeholder
  tokens with the tenant the phone sent; the proxy swaps them for real ones on Azure's hosts.

Nothing is stored. When the phone goes away its channel closes, stdin ends, and the bridge exits: the proxy then
refuses requests that need a credential.

One phone at a time: the phone pings every 10 seconds, and a bridge that has not heard from it for STALE_SECONDS
exits, since a phone that lost its network can leave the channel half open for a long time. A new bridge replaces an
older one only when that one is stale; otherwise it says it is busy and exits, and its phone retries later. Replacing
a live bridge would let two phones take it from each other in turn, each answering the other's requests with its own
credentials, or with none.
"""

import base64
import itertools
import json
import os
import signal
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SECRET = os.environ["EGRESS_SECRET"]
PID_FILE = "/tmp/pi-mobile-bridge.pid"
# A write waits for the person on the phone; credentials.py gives up after its own approval timeout.
ANSWER_TIMEOUT_SECONDS = 6 * 60
# Three missed pings.
STALE_SECONDS = 35

pending = {}
pending_lock = threading.Lock()
ids = itertools.count(1)
write_lock = threading.Lock()
config = {"azureTenant": "00000000-0000-0000-0000-000000000000"}
heard = {"at": time.monotonic()}


def send(message):
    with write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def ask_phone(body):
    request_id = next(ids)
    waiter = {"event": threading.Event(), "result": None}
    with pending_lock:
        pending[request_id] = waiter
    send({"type": "authorize", "id": request_id, "body": body})
    answered = waiter["event"].wait(ANSWER_TIMEOUT_SECONDS)
    with pending_lock:
        pending.pop(request_id, None)
    if not answered:
        return {"reason": "手機沒有回應"}
    return waiter["result"]


def read_phone():
    for line in sys.stdin:
        heard["at"] = time.monotonic()
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("type") == "result":
            with pending_lock:
                waiter = pending.get(message.get("id"))
            if waiter is not None:
                result = message.get("result")
                waiter["result"] = result if isinstance(result, dict) else {"reason": "手機的回答看不懂"}
                waiter["event"].set()
        elif message.get("type") == "config":
            tenant = message.get("azureTenant")
            if isinstance(tenant, str) and tenant:
                config["azureTenant"] = tenant
    # The phone's channel closed.
    os._exit(0)


def azure_placeholder(resource):
    tenant = config["azureTenant"]
    now = int(time.time())

    def encode(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    claims = {
        "aud": resource,
        "iss": f"https://sts.windows.net/{tenant}/",
        "tid": tenant,
        "oid": "00000000-0000-0000-0000-00000000p1m0",
        "appid": "pi-mobile-egress",
        "iat": now,
        "nbf": now,
        "exp": now + 3600,
    }
    signature = base64.urlsafe_b64encode(b"injected-by-pi-egress").rstrip(b"=").decode()
    token = f"{encode({'alg': 'RS256', 'typ': 'JWT', 'kid': 'pi-egress'})}.{encode(claims)}.{signature}"
    return {"access_token": token, "expires_on": str(now + 3600), "resource": resource, "token_type": "Bearer"}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if urlparse(self.path).path != "/egress/authorize" or self.headers.get("x-egress-secret") != SECRET:
            return self.reply(401, {"error": "unauthorized"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.reply(400, {"error": "bad request"})
        self.reply(200, ask_phone(body))

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/egress/alive" and self.headers.get("x-egress-secret") == SECRET:
            return self.reply(200, {"quiet": time.monotonic() - heard["at"]})
        if url.path != "/azure/identity":
            return self.reply(404, {"error": "not found"})
        resource = parse_qs(url.query).get("resource", ["https://management.core.windows.net/"])[0]
        self.reply(200, azure_placeholder(resource))

    def log_message(self, format, *args):
        pass


def older_is_live():
    """Whether another bridge holds the ports and has heard from its phone lately."""
    request = urllib.request.Request("http://127.0.0.1:9001/egress/alive", headers={"x-egress-secret": SECRET})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response).get("quiet", STALE_SECONDS) < STALE_SECONDS
    except (OSError, ValueError):
        return False


def watch_phone():
    while True:
        time.sleep(5)
        if time.monotonic() - heard["at"] > STALE_SECONDS:
            os._exit(0)


def take_over():
    """Stop an older bridge whose phone went quiet, and record this one."""
    try:
        with open(PID_FILE) as file:
            old = int(file.read().strip())
        if old != os.getpid():
            os.kill(old, signal.SIGTERM)
            time.sleep(0.3)
    except (OSError, ValueError):
        pass
    with open(PID_FILE, "w") as file:
        file.write(str(os.getpid()))


def serve(address):
    for _ in range(20):
        try:
            server = ThreadingHTTPServer(address, Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            return
        except OSError:
            time.sleep(0.25)
    sys.stderr.write(f"cannot listen on {address}\n")
    os._exit(1)


if __name__ == "__main__":
    if older_is_live():
        send({"type": "busy"})
        sys.exit(3)
    take_over()
    threading.Thread(target=watch_phone, daemon=True).start()
    serve(("127.0.0.1", 9001))
    serve(("0.0.0.0", 9002))
    send({"type": "ready"})
    read_phone()
