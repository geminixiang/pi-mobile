# Sandbox image: one container per conversation, driven by the pi-env daemon over `docker exec -i`.
# A general workbench for the agent: code (Node, Python with uv, build tools), data (sqlite, jq), documents
# (pandoc, poppler), and media (ImageMagick, ffmpeg), with CJK fonts so rendered charts and images show Chinese.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl wget file git jq less openssh-client procps tree rsync unzip zip xz-utils \
		python3 python3-pip python3-venv python3-dev \
		ripgrep fd-find sqlite3 \
		imagemagick ffmpeg pandoc poppler-utils \
		fonts-noto-cjk \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# GitHub CLI. It authenticates through the egress proxy (sandbox/egress), which injects the user's token; the
# container only has a placeholder GH_TOKEN.
RUN mkdir -p -m 755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# Google Cloud CLI. Like gh, it authenticates through the egress proxy: its access token file holds a placeholder that
# the proxy swaps for a short-lived token minted on the phone.
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg -o /etc/apt/keyrings/cloud.google.asc \
	&& echo "deb [signed-by=/etc/apt/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt cloud-sdk main" \
		> /etc/apt/sources.list.d/google-cloud-sdk.list \
	&& apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /etc/pi-egress && echo injected-by-pi-egress > /etc/pi-egress/gcloud-token

# uv for Python projects and one-off scripts (`uv run --with pandas script.py`), pnpm through corepack.
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /usr/local/bin/
RUN corepack enable pnpm && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version > /dev/null

# Azure CLI, as a uv tool (Microsoft's apt repo has no Debian 13 build). It signs in as a managed identity whose token
# endpoint is the egress bridge (IDENTITY_ENDPOINT); the proxy swaps the placeholder tokens it hands out for real ones.
RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --python 3.13 azure-cli==2.91.0 \
	&& uv cache clean

# Cloudflare CLIs (cf, wrangler). They authenticate through the egress proxy with a placeholder CLOUDFLARE_API_TOKEN.
RUN npm install --global --no-fund --no-audit cf@1.0.0-beta.18 wrangler@4.151.2 && npm cache clean --force
ENV UV_LINK_MODE=copy PIP_BREAK_SYSTEM_PACKAGES=1

# Static aarch64 build from @earendil-works/pi-env (bin/pi-env-linux-arm64/pi-env).
COPY pi-env /usr/local/bin/pi-env

ENV HOME=/root
WORKDIR /workspace
CMD ["sleep", "infinity"]
