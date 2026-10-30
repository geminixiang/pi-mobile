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
from typing import NoReturn, TypedDict
from urllib.parse import parse_qs, urlparse

SECRET: str = os.environ["EGRESS_SECRET"]
PID_FILE: str = "/tmp/pi-mobile-bridge.pid"
ANSWER_TIMEOUT_SECONDS: float = 10
STALE_SECONDS: float = 35


class Waiter(TypedDict):
    event: threading.Event
    result: dict[str, object] | None


pending: dict[int, Waiter] = {}
pending_lock: threading.Lock = threading.Lock()
ids: itertools.count[int] = itertools.count(1)
write_lock: threading.Lock = threading.Lock()
config: dict[str, str] = {"azureTenant": "00000000-0000-0000-0000-000000000000"}
heard: dict[str, float] = {"at": time.monotonic()}


def send(message: dict[str, object]) -> None:
    with write_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def ask_phone(body: object) -> dict[str, object]:
    request_id = next(ids)
    waiter: Waiter = {"event": threading.Event(), "result": None}
    with pending_lock:
        pending[request_id] = waiter
    send({"type": "authorize", "id": request_id, "body": body})
    answered = waiter["event"].wait(ANSWER_TIMEOUT_SECONDS)
    with pending_lock:
        pending.pop(request_id, None)
    result = waiter["result"]
    if not answered or result is None:
        return {"reason": "手機沒有回應"}
    return result


def read_phone() -> NoReturn:
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
    os._exit(0)


def azure_placeholder(resource: str) -> dict[str, str]:
    tenant = config["azureTenant"]
    now = int(time.time())

    def encode(value: object) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    claims: dict[str, object] = {
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
    def reply(self, status: int, body: object) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/egress/authorize" or self.headers.get("x-egress-secret") != SECRET:
            return self.reply(401, {"error": "unauthorized"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.reply(400, {"error": "bad request"})
        self.reply(200, ask_phone(body))

    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path == "/egress/alive" and self.headers.get("x-egress-secret") == SECRET:
            return self.reply(200, {"quiet": time.monotonic() - heard["at"]})
        if url.path != "/azure/identity":
            return self.reply(404, {"error": "not found"})
        resource = parse_qs(url.query).get("resource", ["https://management.core.windows.net/"])[0]
        self.reply(200, azure_placeholder(resource))

    def log_message(self, format: str, *args: object) -> None:
        pass


def older_is_live() -> bool:
    request = urllib.request.Request("http://127.0.0.1:9001/egress/alive", headers={"x-egress-secret": SECRET})
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            answer: dict[str, float] = json.load(response)
            return answer.get("quiet", STALE_SECONDS) < STALE_SECONDS
    except (OSError, ValueError):
        return False


def watch_phone() -> NoReturn:
    while True:
        time.sleep(5)
        if time.monotonic() - heard["at"] > STALE_SECONDS:
            os._exit(0)


def take_over() -> None:
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


def serve(address: tuple[str, int]) -> None:
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
