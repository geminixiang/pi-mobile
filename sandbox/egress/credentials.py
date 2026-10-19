"""mitmproxy addon: GitHub and Google Cloud credentials for sandbox containers without putting them in them.

Google Cloud (*.googleapis.com) works the same way as GitHub below: gcloud in the sandbox sends a placeholder bearer
token, and the proxy swaps in a short-lived access token the phone minted. Reads go straight through; writes (any
method but GET/HEAD, except POSTs that only read, such as :list and :search) wait for approval on the phone.


Sandboxes send all HTTP(S) through this proxy. Only the GitHub hosts below are intercepted (see --allow-hosts in
the Dockerfile); everything else passes through untouched. For GitHub requests the addon drops any Authorization the
sandbox sent (gh's placeholder GH_TOKEN), asks the relay for the user's token, and injects it.

Reads (clone, fetch, REST GET, GraphQL queries) get the token right away. Writes (git push, REST POST/PATCH/PUT/
DELETE, GraphQL mutations, LFS uploads) are held until the user approves them on the phone; the relay forwards the
question and returns the token only when approved. Without a connected phone, reads go out anonymously and writes are
refused.
"""

import asyncio
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request

from mitmproxy import http

RELAY_URL = os.environ["RELAY_URL"].rstrip("/")
SECRET = os.environ["EGRESS_SECRET"]
API_HOSTS = {"api.github.com", "uploads.github.com"}
GIT_HOST = "github.com"
RAW_HOST = "raw.githubusercontent.com"
READ_CACHE_SECONDS = 30
APPROVAL_TIMEOUT_SECONDS = 330
GOOGLE_HOST = re.compile(r"^[a-z0-9.-]+\.googleapis\.com$")
# POST methods that only read (List, Search, Get, IAM checks); everything else that is not GET/HEAD is a write.
GOOGLE_READ_VERB = re.compile(r":(list|search|get|batchGet|getIamPolicy|testIamPermissions|lookup|aggregatedList|fetch\w*)$")
MUTATION = re.compile(r"^\s*(#[^\n]*\n\s*)*mutation\b")


def preview(value, limit=2000):
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        value = json.dumps(value, indent=2, ensure_ascii=False)
    else:
        try:
            value = json.dumps(json.loads(value), indent=2, ensure_ascii=False)
        except ValueError:
            pass
    return value if len(value) <= limit else value[:limit] + "\n…"


def ref_updates(body):
    """Ref commands at the start of a receive-pack request: pkt-lines "<old> <new> <ref>" up to a flush packet."""
    lines, i = [], 0
    while i + 4 <= len(body):
        try:
            size = int(body[i : i + 4], 16)
        except ValueError:
            break
        if size == 0:
            break
        line = body[i + 4 : i + size].split(b"\0")[0].decode(errors="replace").strip()
        i += size
        parts = line.split(" ")
        if len(parts) != 3:
            continue
        old, new, ref = parts
        name = ref.removeprefix("refs/heads/")
        if set(old) == {"0"}:
            lines.append(f"新增 {name} → {new[:7]}")
        elif set(new) == {"0"}:
            lines.append(f"刪除 {name}")
        else:
            lines.append(f"{name}: {old[:7]} → {new[:7]}")
    return lines


def classify(request):
    """None for a read; (title, detail) for a write that needs the user's approval."""
    method, host = request.method, request.pretty_host
    path = request.path.split("?")[0]
    if method in ("GET", "HEAD", "OPTIONS") or host == RAW_HOST:
        return None
    if host == "api.github.com" and path == "/graphql":
        try:
            body = json.loads(request.get_text(strict=False) or "{}")
        except ValueError:
            body = {}
        query = body.get("query", "") if isinstance(body, dict) else ""
        if not MUTATION.match(query):
            return None
        name = re.search(r"mutation\s+(\w+)", query)
        return (f"GitHub GraphQL {name.group(1) if name else 'mutation'}", preview(body.get("variables")))
    if host in API_HOSTS:
        return (f"GitHub {method} {path}", preview(request.get_text(strict=False)))
    if path.endswith("/git-upload-pack"):
        return None
    if path.endswith("/git-receive-pack"):
        repo = path[1 : -len("/git-receive-pack")].removesuffix(".git")
        return (f"git push {repo}", "\n".join(ref_updates(request.get_content(strict=False) or b"")))
    if path.endswith("/info/lfs/objects/batch"):
        try:
            operation = json.loads(request.get_text(strict=False) or "{}").get("operation")
        except ValueError:
            operation = None
        if operation != "upload":
            return None
        repo = path[1 : -len("/info/lfs/objects/batch")].removesuffix(".git")
        return (f"git lfs push {repo}", "")
    return (f"GitHub {method} {path}", "")


def classify_google(request):
    """None for a read; (title, detail) for a Google Cloud write that needs approval."""
    path = request.path.split("?")[0]
    if request.method in ("GET", "HEAD", "OPTIONS") or GOOGLE_READ_VERB.search(path):
        return None
    service = request.pretty_host.removesuffix(".googleapis.com")
    return (f"Google Cloud {request.method} {service} {path}", preview(request.get_text(strict=False)))


def authorize(client, write, title="", detail="", service="github"):
    payload = json.dumps({"client": client, "write": write, "title": title, "detail": detail, "service": service}).encode()
    request = urllib.request.Request(
        f"{RELAY_URL}/egress/authorize",
        data=payload,
        headers={"Content-Type": "application/json", "X-Egress-Secret": SECRET},
        method="POST",
    )
    timeout = APPROVAL_TIMEOUT_SECONDS if write else 10
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"{}")


def pkt(data):
    return f"{len(data) + 4:04x}".encode() + data


def deny(flow, host, reason):
    message = f"pi mobile: {reason}"
    if flow.request.path.split("?")[0].endswith("/git-receive-pack"):
        # git reads a push response as pkt-lines; band 3 is a fatal error it prints as "remote error: ...".
        body = pkt(b"\x03" + message.encode() + b"\n") + b"0000"
        flow.response = http.Response.make(200, body, {"Content-Type": "application/x-git-receive-pack-result"})
        return
    if host in API_HOSTS:
        flow.response = http.Response.make(403, json.dumps({"message": message}), {"Content-Type": "application/json"})
    else:
        # git prints text/plain error bodies as "remote: ..." lines.
        flow.response = http.Response.make(403, message + "\n", {"Content-Type": "text/plain"})


def set_token(request, host, token):
    if host in API_HOSTS:
        request.headers["Authorization"] = f"Bearer {token}"
    elif host == GIT_HOST:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        request.headers["Authorization"] = f"Basic {basic}"
    else:
        request.headers["Authorization"] = f"token {token}"


class Credentials:
    def __init__(self):
        self.reads = {}  # (service, client IP) -> (token or None, expiry)

    async def read_token(self, client, service="github"):
        cached = self.reads.get((service, client))
        if cached and cached[1] > time.monotonic():
            return cached[0]
        try:
            token = (await asyncio.to_thread(authorize, client, False, "", "", service)).get("token")
        except (OSError, urllib.error.URLError, ValueError):
            token = None
        self.reads[(service, client)] = (token, time.monotonic() + (READ_CACHE_SECONDS if token else 5))
        return token

    async def google(self, flow, client):
        flow.request.headers.pop("Authorization", None)
        write = classify_google(flow.request)
        if write is None:
            token = await self.read_token(client, "gcloud")
        else:
            try:
                result = await asyncio.to_thread(authorize, client, True, *write, "gcloud")
            except (OSError, urllib.error.URLError, ValueError) as error:
                result = {"reason": f"無法聯絡 relay（{error}）"}
            token = result.get("token")
            if not token:
                message = json.dumps({"error": {"code": 403, "message": f"pi mobile: {result.get('reason') or '寫入被拒絕'}", "status": "PERMISSION_DENIED"}})
                flow.response = http.Response.make(403, message, {"Content-Type": "application/json"})
                return
        if token:
            flow.request.headers["Authorization"] = f"Bearer {token}"
        else:
            message = json.dumps({"error": {"code": 401, "message": "pi mobile: 手機沒有連上，或沒有設定 Google Cloud 憑證", "status": "UNAUTHENTICATED"}})
            flow.response = http.Response.make(401, message, {"Content-Type": "application/json"})

    async def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        if GOOGLE_HOST.match(host):
            await self.google(flow, flow.client_conn.peername[0].removeprefix("::ffff:"))
            return
        if host not in API_HOSTS and host not in (GIT_HOST, RAW_HOST):
            return
        flow.request.headers.pop("Authorization", None)
        client = flow.client_conn.peername[0].removeprefix("::ffff:")
        write = classify(flow.request)
        if write is None:
            token = await self.read_token(client)
            if token:
                set_token(flow.request, host, token)
            return
        try:
            result = await asyncio.to_thread(authorize, client, True, *write)
        except (OSError, urllib.error.URLError, ValueError) as error:
            deny(flow, host, f"無法聯絡 relay（{error}）")
            return
        token = result.get("token")
        if not token:
            deny(flow, host, result.get("reason") or "寫入被拒絕")
            return
        set_token(flow.request, host, token)


addons = [Credentials()]
