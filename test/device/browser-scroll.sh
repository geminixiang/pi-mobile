#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
PORT=$1
CDP_PORT=$PORT ./test/device/ui.sh "async () => {
	const result = await window.Capacitor.Plugins.Browser.act({ bot: 'browser-scroll-test', steps: [{ action: 'open', url: 'https://example.com' }, { action: 'scroll', direction: 'down' }], screenshot: false });
	if (result.error) throw new Error(result.error);
	return 'scrolled right after open';
}"
