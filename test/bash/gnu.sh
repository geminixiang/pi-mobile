#!/bin/sh
set -e
cd "$(dirname "$0")"
work="$HOME/.cache/pi-mobile-bash-gnu"
rm -rf "$work" && mkdir -p "$work/out"
node -e 'const c = require("./cases.json"); const fs = require("fs"); fs.mkdirSync(process.argv[1], { recursive: true }); for (const [name, body] of Object.entries(c)) fs.writeFileSync(`${process.argv[1]}/${name}.sh`, body);' "$work/cases"
printf 'FROM debian:13\nRUN apt-get update && apt-get install -y --no-install-recommends jq ripgrep tree gawk file bsdextrautils diffutils && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/gawk /usr/bin/awk\n' | docker build -q -t pi-mobile-bash-gnu - > /dev/null
docker run --rm -v "$work:/j" pi-mobile-bash-gnu bash -c 'for f in /j/cases/*.sh; do n=$(basename "$f" .sh); mkdir -p "/w/$n"; cd "/w/$n"; env -i HOME=/ USER=pi TZ=Asia/Taipei PATH=/usr/bin:/bin LANG=C.UTF-8 timeout 20 bash "$f" > "/j/out/$n.out" 2> /dev/null; echo $? > "/j/out/$n.code"; done'
node -e 'const c = require("./cases.json"); const fs = require("fs"); const out = {}; for (const name of Object.keys(c)) out[name] = { stdout: fs.readFileSync(`${process.argv[1]}/${name}.out`, "utf8"), exit: Number(fs.readFileSync(`${process.argv[1]}/${name}.code`, "utf8")) }; fs.writeFileSync("gnu.json", JSON.stringify(out, null, 1));' "$work/out"
echo "wrote gnu.json"
