#!/bin/sh
cd "$(dirname "$0")/../.."
DRIVER=test/device/cdp.ts
[ -n "$WEBKIT" ] && DRIVER=test/device/webkit.ts
node "$DRIVER" "(async () => { $(cat test/device/ui.js)
return await ($1)(); })()"
