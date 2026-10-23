#!/bin/sh
cd "$(dirname "$0")/.."
node test/cdp.ts "(async () => { $(cat test/ui.js)
return await ($1)(); })()"
