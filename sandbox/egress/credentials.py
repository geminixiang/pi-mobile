"""mitmproxy addon: GitHub and Google Cloud credentials for sandbox containers without putting them in them.

Cloudflare (api.cloudflare.com, used by cf and wrangler) works like Google Cloud: a placeholder CLOUDFLARE_API_TOKEN,
an OAuth access token from the phone, and approval for anything but GET/HEAD and the read-only GraphQL analytics API.

Azure (ARM, Graph, Key Vault, Storage) works the same way, except that az signs in as a managed identity served by
the bridge with placeholder tokens; the proxy asks the phone for a real token for the host's resource (one per scope).

Google Cloud (*.googleapis.com) works the same way as GitHub below: gcloud in the sandbox sends a placeholder bearer
token, and the proxy swaps in a short-lived access token the phone minted. Reads go straight through; writes (any
method but GET/HEAD, except POSTs that only read, such as :list and :search) wait for approval on the phone.


Sandboxes send all HTTP(S) through this proxy. Only HTTPS to the hosts below gets credentials, and only TLS to them is
intercepted (see --allow-hosts in the Dockerfile); everything else passes through untouched. For GitHub requests the addon drops any Authorization the
sandbox sent (gh's placeholder GH_TOKEN), asks the phone (through bridge.py) for the user's token, and
injects it.

Reads (clone, fetch, REST GET, GraphQL queries) get the token right away. Writes (git push, REST POST/PATCH/PUT/
DELETE, GraphQL mutations, LFS uploads) are held until the user approves them on the phone; the bridge forwards the
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

BRIDGE_URL = os.environ["BRIDGE_URL"].rstrip("/")
SECRET = os.environ["EGRESS_SECRET"]
API_HOSTS = {"api.github.com", "uploads.github.com"}
GIT_HOST = "github.com"
RAW_HOST = "raw.githubusercontent.com"
READ_CACHE_SECONDS = 30
APPROVAL_TIMEOUT_SECONDS = 330
GOOGLE_HOST = re.compile(r"^[a-z0-9.-]+\.googleapis\.com$")
# POST methods that only read (List, Search, Get, IAM checks); everything else that is not GET/HEAD is a write.
GOOGLE_READ_VERB = re.compile(r":(list|search|get|batchGet|getIamPolicy|testIamPermissions|lookup|aggregatedList)$")
GRAPHQL_STRINGS_AND_COMMENTS = re.compile(r'"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|#[^\n]*')
MUTATION = re.compile(r"\bmutation\b")


def has_mutation(query):
    return bool(MUTATION.search(GRAPHQL_STRINGS_AND_COMMENTS.sub(" ", query)))


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
    method, host = request.method, request.host
    path = request.path.split("?")[0]
    if method in ("GET", "HEAD", "OPTIONS") or host == RAW_HOST:
        return None
    if host == "api.github.com" and path == "/graphql":
        try:
            body = json.loads(request.get_text(strict=False) or "{}")
        except ValueError:
            body = {}
        query = body.get("query", "") if isinstance(body, dict) else ""
        if not has_mutation(query):
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
    service = request.host.removesuffix(".googleapis.com")
    return (f"Google Cloud {request.method} {service} {path}", preview(request.get_text(strict=False)))


CLOUDFLARE_HOST = "api.cloudflare.com"


def classify_cloudflare(request):
    """None for a read; (title, detail) for a Cloudflare write that needs approval."""
    path = request.path.split("?")[0]
    if request.method in ("GET", "HEAD", "OPTIONS") or path == "/client/v4/graphql":
        return None
    return (f"Cloudflare {request.method} {path.removeprefix('/client/v4')}", preview(request.get_text(strict=False)))


AZURE_SCOPES = [
    (re.compile(r"^management\.azure\.com$"), "https://management.core.windows.net//.default"),
    (re.compile(r"^graph\.microsoft\.com$"), "https://graph.microsoft.com/.default"),
    (re.compile(r"^[a-z0-9-]+\.vault\.azure\.net$"), "https://vault.azure.net/.default"),
    (re.compile(r"^[a-z0-9-]+\.(blob|queue|table|file|dfs)\.core\.windows\.net$"), "https://storage.azure.com/.default"),
]
# POSTs that only read: Resource Graph queries, name checks. listKeys and other actions return secrets or change state.
AZURE_READ_POST = re.compile(r"(/providers/Microsoft\.ResourceGraph/resources|/checkNameAvailability)$", re.I)


def azure_scope(host):
    for pattern, scope in AZURE_SCOPES:
        if pattern.match(host):
            return scope
    return None


def classify_azure(request):
    """None for a read; (title, detail) for an Azure write that needs approval."""
    path = request.path.split("?")[0]
    if request.method in ("GET", "HEAD", "OPTIONS") or (request.method == "POST" and AZURE_READ_POST.search(path)):
        return None
    return (f"Azure {request.method} {request.host} {path}", preview(request.get_text(strict=False)))


def authorize(client, write, title="", detail="", service="github", scope=""):
    payload = json.dumps({"client": client, "write": write, "title": title, "detail": detail, "service": service, "scope": scope}).encode()
    request = urllib.request.Request(
        f"{BRIDGE_URL}/egress/authorize",
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

    async def read_token(self, client, service="github", scope=""):
        cached = self.reads.get((service, client, scope))
        if cached and cached[1] > time.monotonic():
            return cached[0]
        try:
            token = (await asyncio.to_thread(authorize, client, False, "", "", service, scope)).get("token")
        except (OSError, urllib.error.URLError, ValueError):
            token = None
        self.reads[(service, client, scope)] = (token, time.monotonic() + (READ_CACHE_SECONDS if token else 5))
        return token

    async def minted(self, flow, client, service, write, label, error_body, scope=""):
        """Services whose token the phone mints: swap the placeholder, asking for approval first on writes."""
        flow.request.headers.pop("Authorization", None)
        if write is None:
            token = await self.read_token(client, service, scope)
            reason = f"手機沒有連上，或沒有設定 {label} 憑證"
        else:
            try:
                result = await asyncio.to_thread(authorize, client, True, *write, service, scope)
            except (OSError, urllib.error.URLError, ValueError) as error:
                result = {"reason": f"手機沒有連上（{error}）"}
            token = result.get("token")
            reason = result.get("reason") or "寫入被拒絕"
        if token:
            flow.request.headers["Authorization"] = f"Bearer {token}"
            return
        status = 401 if write is None else 403
        flow.response = http.Response.make(status, json.dumps(error_body(status, f"pi mobile: {reason}")), {"Content-Type": "application/json"})

    async def request(self, flow: http.HTTPFlow):
        if flow.request.scheme != "https":
            return
        host = flow.request.host
        client = flow.client_conn.peername[0].removeprefix("::ffff:")
        if GOOGLE_HOST.match(host):
            await self.minted(
                flow, client, "gcloud", classify_google(flow.request), "Google Cloud",
                lambda code, message: {"error": {"code": code, "message": message, "status": "PERMISSION_DENIED" if code == 403 else "UNAUTHENTICATED"}},
            )
            return
        scope = azure_scope(host)
        if scope:
            await self.minted(
                flow, client, "azure", classify_azure(flow.request), "Azure",
                lambda code, message: {"error": {"code": "AuthorizationFailed" if code == 403 else "AuthenticationFailed", "message": message}},
                scope,
            )
            return
        if host == CLOUDFLARE_HOST:
            await self.minted(
                flow, client, "cloudflare", classify_cloudflare(flow.request), "Cloudflare",
                lambda code, message: {"success": False, "errors": [{"code": 10000, "message": message}], "messages": [], "result": None},
            )
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
            deny(flow, host, f"手機沒有連上（{error}）")
            return
        token = result.get("token")
        if not token:
            deny(flow, host, result.get("reason") or "寫入被拒絕")
            return
        set_token(flow.request, host, token)


addons = [Credentials()]
