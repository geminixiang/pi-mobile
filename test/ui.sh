#!/bin/sh
cd "$(dirname "$0")/.."
DRIVER=test/cdp.ts
[ -n "$WEBKIT" ] && DRIVER=test/webkit.ts
node "$DRIVER" "(async () => { $(cat test/ui.js)
return await ($1)(); })()"
