FROM mitmproxy/mitmproxy:12.2.3

COPY credentials.py /egress/credentials.py
COPY bridge.py /egress/bridge.py

CMD ["mitmdump", "--listen-port", "8080", "--set", "block_global=false", "--set", "connection_strategy=lazy", \
	"--set", "stream_large_bodies=64m", \
	"--allow-hosts", "^(api\\.|uploads\\.)?github\\.com(:443)?$", \
	"--allow-hosts", "^raw\\.githubusercontent\\.com(:443)?$", \
	"--allow-hosts", "^[a-z0-9.-]+\\.googleapis\\.com(:443)?$", \
	"--allow-hosts", "^api\\.cloudflare\\.com(:443)?$", \
	"--allow-hosts", "^(management\\.azure\\.com|graph\\.microsoft\\.com|[a-z0-9-]+\\.vault\\.azure\\.net|[a-z0-9-]+\\.(blob|queue|table|file|dfs)\\.core\\.windows\\.net)(:443)?$", \
	"-s", "/egress/credentials.py"]
