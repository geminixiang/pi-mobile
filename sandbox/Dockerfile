# Sandbox image: one container per conversation, driven by the pi-env daemon over `docker exec -i`.
FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl file git jq less openssh-client procps \
		python3 python3-pip python3-venv ripgrep fd-find unzip zip \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# Static aarch64 build from @earendil-works/pi-env (bin/pi-env-linux-arm64/pi-env).
COPY pi-env /usr/local/bin/pi-env

ENV HOME=/root
WORKDIR /workspace
CMD ["sleep", "infinity"]
