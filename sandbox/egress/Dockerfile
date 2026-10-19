# Egress proxy for sandbox containers: mitmproxy with the GitHub credential addon (credentials.py).
# Only GitHub, Google Cloud, and Cloudflare API hosts are intercepted; all other traffic is passed through without TLS interception.
FROM mitmproxy/mitmproxy:12.2.3

COPY credentials.py /egress/credentials.py

CMD ["mitmdump", "--listen-port", "8080", "--set", "block_global=false", "--set", "connection_strategy=lazy", \
	"--set", "stream_large_bodies=64m", \
	"--allow-hosts", "^(api\\.|uploads\\.)?github\\.com(:443)?$", \
	"--allow-hosts", "^raw\\.githubusercontent\\.com(:443)?$", \
	"--allow-hosts", "^[a-z0-9.-]+\\.googleapis\\.com(:443)?$", \
	"--allow-hosts", "^api\\.cloudflare\\.com(:443)?$", \
	"-s", "/egress/credentials.py"]
