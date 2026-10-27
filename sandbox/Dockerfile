FROM node:26.12.1-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl wget file git jq less openssh-client procps tree rsync unzip zip xz-utils \
		python3 python3-pip python3-venv python3-dev \
		ripgrep fd-find sqlite3 \
		imagemagick ffmpeg pandoc poppler-utils \
		fonts-noto-cjk \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

RUN mkdir -p -m 755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg -o /etc/apt/keyrings/cloud.google.asc \
	&& echo "deb [signed-by=/etc/apt/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt cloud-sdk main" \
		> /etc/apt/sources.list.d/google-cloud-sdk.list \
	&& apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /etc/pi-egress && echo injected-by-pi-egress > /etc/pi-egress/gcloud-token

COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /uvx /usr/local/bin/

RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --python 3.13 azure-cli==2.91.0 \
	&& uv cache clean

RUN npm install --global --no-fund --no-audit pnpm@12.15.0 cf@1.0.0-beta.23 wrangler@4.153.0 && npm cache clean --force
ENV UV_LINK_MODE=copy PIP_BREAK_SYSTEM_PACKAGES=1

COPY pi-env /usr/local/bin/pi-env

ENV HOME=/root
WORKDIR /workspace
CMD ["sleep", "infinity"]
