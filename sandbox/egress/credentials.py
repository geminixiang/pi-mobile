import asyncio
import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable

from mitmproxy import http

BRIDGE_URL: str = os.environ["BRIDGE_URL"].rstrip("/")
SECRET: str = os.environ["EGRESS_SECRET"]
API_HOSTS: set[str] = {"api.github.com", "uploads.github.com"}
GIT_HOST: str = "github.com"
RAW_HOST: str = "raw.githubusercontent.com"
CACHE_SECONDS: float = 30
GOOGLE_HOST: re.Pattern[str] = re.compile(r"^[a-z0-9.-]+\.googleapis\.com$")
CLOUDFLARE_HOST: str = "api.cloudflare.com"
AZURE_SCOPES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^management\.azure\.com$"), "https://management.core.windows.net//.default"),
    (re.compile(r"^graph\.microsoft\.com$"), "https://graph.microsoft.com/.default"),
    (re.compile(r"^[a-z0-9-]+\.vault\.azure\.net$"), "https://vault.azure.net/.default"),
    (re.compile(r"^[a-z0-9-]+\.(blob|queue|table|file|dfs)\.core\.windows\.net$"), "https://storage.azure.com/.default"),
]


ErrorBody = Callable[[int, str], dict[str, object]]


def azure_scope(host: str) -> str | None:
    for pattern, scope in AZURE_SCOPES:
        if pattern.match(host):
            return scope
    return None


def authorize(client: str, service: str = "github", scope: str = "") -> dict[str, object]:
    payload = json.dumps({"client": client, "service": service, "scope": scope}).encode()
    request = urllib.request.Request(
        f"{BRIDGE_URL}/egress/authorize",
        data=payload,
        headers={"Content-Type": "application/json", "X-Egress-Secret": SECRET},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        answer: dict[str, object] = json.loads(response.read() or b"{}")
        return answer


def set_token(request: http.Request, host: str, token: str) -> None:
    if host in API_HOSTS:
        request.headers["Authorization"] = f"Bearer {token}"
    elif host == GIT_HOST:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        request.headers["Authorization"] = f"Basic {basic}"
    else:
        request.headers["Authorization"] = f"token {token}"


class Credentials:
    def __init__(self) -> None:
        self.tokens: dict[tuple[str, str, str], tuple[str | None, float]] = {}

    async def token(self, client: str, service: str = "github", scope: str = "") -> str | None:
        cached = self.tokens.get((service, client, scope))
        if cached and cached[1] > time.monotonic():
            return cached[0]
        try:
            found = (await asyncio.to_thread(authorize, client, service, scope)).get("token")
            token = found if isinstance(found, str) else None
        except (OSError, urllib.error.URLError, ValueError):
            token = None
        self.tokens[(service, client, scope)] = (token, time.monotonic() + (CACHE_SECONDS if token else 5))
        return token

    async def minted(self, flow: http.HTTPFlow, client: str, service: str, label: str, error_body: ErrorBody, scope: str = "") -> None:
        flow.request.headers.pop("Authorization", None)
        token = await self.token(client, service, scope)
        if token:
            flow.request.headers["Authorization"] = f"Bearer {token}"
            return
        message = f"pi mobile: 手機沒有連上，或沒有設定 {label} 憑證"
        flow.response = http.Response.make(401, json.dumps(error_body(401, message)), {"Content-Type": "application/json"})

    async def request(self, flow: http.HTTPFlow) -> None:
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


addons: list[Credentials] = [Credentials()]
