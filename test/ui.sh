#!/bin/sh
# Run an async page function with the helpers from test/ui.js. Usage: test/ui.sh 'async () => { ... }'
cd "$(dirname "$0")/.."
node test/cdp.ts "(async () => { $(cat test/ui.js)
return await ($1)(); })()"
