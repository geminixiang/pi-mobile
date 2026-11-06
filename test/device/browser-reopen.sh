#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
PORT=$1
CDP_PORT=$PORT ./test/device/ui.sh "async () => {
	const Browser = window.Capacitor.Plugins.Browser;
	const bot = 'browser-reopen-' + Date.now();
	const open = async () => {
		const { tab } = await Browser.newTab({ bot });
		const result = await Browser.act({ bot, tab, steps: [{ action: 'open', url: 'https://example.com/' }], screenshot: false });
		if (result.error) throw new Error(result.error);
		return tab;
	};
	await Browser.closeTab({ bot, tab: await open() });
	await Browser.closeTab({ bot, tab: await open() });
	await Browser.forget({ bot });
	return 'a tab opened right after the last one closed does not freeze';
}"
