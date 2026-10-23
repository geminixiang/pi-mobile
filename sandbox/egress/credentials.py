"""mitmproxy addon: GitHub, Google Cloud, Cloudflare, and Azure credentials for sandbox containers without putting
them in them.

Sandboxes send all HTTP(S) through this proxy. Only HTTPS to the hosts below gets credentials, and only TLS to them is
intercepted (see --allow-hosts in the Dockerfile); everything else passes through untouched. The addon drops any
Authorization the sandbox sent (the CLIs' placeholder tokens), asks the phone (through bridge.py) for a token, and
injects it: the user's GitHub token, or a short-lived access token the phone minted for Google Cloud, Cloudflare, or
Azure (az signs in as a managed identity served by the bridge with placeholder tokens; the proxy asks for a token for
the host's resource, one per scope). Without a connected phone, GitHub requests go out anonymously and the others are
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
CACHE_SECONDS = 30
GOOGLE_HOST = re.compile(r"^[a-z0-9.-]+\.googleapis\.com$")
CLOUDFLARE_HOST = "api.cloudflare.com"
AZURE_SCOPES = [
    (re.compile(r"^management\.azure\.com$"), "https://management.core.windows.net//.default"),
    (re.compile(r"^graph\.microsoft\.com$"), "https://graph.microsoft.com/.default"),
    (re.compile(r"^[a-z0-9-]+\.vault\.azure\.net$"), "https://vault.azure.net/.default"),
    (re.compile(r"^[a-z0-9-]+\.(blob|queue|table|file|dfs)\.core\.windows\.net$"), "https://storage.azure.com/.default"),
]


def azure_scope(host):
    for pattern, scope in AZURE_SCOPES:
        if pattern.match(host):
            return scope
    return None


def authorize(client, service="github", scope=""):
    payload = json.dumps({"client": client, "service": service, "scope": scope}).encode()
    request = urllib.request.Request(
        f"{BRIDGE_URL}/egress/authorize",
        data=payload,
        headers={"Content-Type": "application/json", "X-Egress-Secret": SECRET},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read() or b"{}")


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
        self.tokens = {}  # (service, client IP, scope) -> (token or None, expiry)

    async def token(self, client, service="github", scope=""):
        cached = self.tokens.get((service, client, scope))
        if cached and cached[1] > time.monotonic():
            return cached[0]
        try:
            token = (await asyncio.to_thread(authorize, client, service, scope)).get("token")
        except (OSError, urllib.error.URLError, ValueError):
            token = None
        self.tokens[(service, client, scope)] = (token, time.monotonic() + (CACHE_SECONDS if token else 5))
        return token

    async def minted(self, flow, client, service, label, error_body, scope=""):
        """Services whose token the phone mints: swap the placeholder, or refuse without one."""
        flow.request.headers.pop("Authorization", None)
        token = await self.token(client, service, scope)
        if token:
            flow.request.headers["Authorization"] = f"Bearer {token}"
            return
        message = f"pi mobile: 手機沒有連上，或沒有設定 {label} 憑證"
        flow.response = http.Response.make(401, json.dumps(error_body(401, message)), {"Content-Type": "application/json"})

    async def request(self, flow: http.HTTPFlow):
        if flow.request.scheme != "https":
            return
        host = flow.request.host
        client = flow.client_conn.peername[0].removeprefix("::ffff:")
        if GOOGLE_HOST.match(host):
            await self.minted(
                flow, client, "gcloud", "Google Cloud",
                lambda code, message: {"error": {"code": code, "message": message, "status": "UNAUTHENTICATED"}},
            )
            return
        scope = azure_scope(host)
        if scope:
            await self.minted(
                flow, client, "azure", "Azure",
                lambda code, message: {"error": {"code": "AuthenticationFailed", "message": message}},
                scope,
            )
            return
        if host == CLOUDFLARE_HOST:
            await self.minted(
                flow, client, "cloudflare", "Cloudflare",
                lambda code, message: {"success": False, "errors": [{"code": 10000, "message": message}], "messages": [], "result": None},
            )
            return
        if host not in API_HOSTS and host not in (GIT_HOST, RAW_HOST):
            return
        flow.request.headers.pop("Authorization", None)
        token = await self.token(client)
        if token:
            set_token(flow.request, host, token)


addons = [Credentials()]
