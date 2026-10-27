import assert from "node:assert/strict";
import { type Release, updateFrom } from "../../src/app/update.ts";
import type { Check } from "./setup.ts";

const DIGEST = "2bf42cf5b8b6e75b0ca7208c1d25096b7461afbda45b54ff90d69a8c5b552938";

const release = (tag: string, digest: string | null = `sha256:${DIGEST}`): Release => ({
	tag_name: tag,
	assets: [
		{ name: "pi-mobile-darwin-arm64", browser_download_url: `https://github.com/geminixiang/pi-mobile/releases/download/${tag}/pi-mobile-darwin-arm64`, digest: "sha256:00" },
		{ name: `pi-mobile-${tag.slice(1)}.apk`, browser_download_url: `https://github.com/geminixiang/pi-mobile/releases/download/${tag}/pi-mobile-${tag.slice(1)}.apk`, digest },
	],
});

export const checks: Check[] = [
	[
		"a newer release offers its APK with the digest GitHub published",
		async () => {
			assert.deepEqual(updateFrom(release("v0.9.0"), "0.8.0"), {
				version: "0.9.0",
				url: "https://github.com/geminixiang/pi-mobile/releases/download/v0.9.0/pi-mobile-0.9.0.apk",
				sha256: DIGEST,
			});
			assert.equal(updateFrom(release("v0.10.0"), "0.9.3")?.version, "0.10.0");
			assert.equal(updateFrom(release("v1.0.0"), "0.9.0-dev")?.version, "1.0.0");
		},
	],
	[
		"the same, an older or an unverifiable release offers nothing",
		async () => {
			assert.equal(updateFrom(release("v0.9.0"), "0.9.0"), undefined);
			assert.equal(updateFrom(release("v0.9.0"), "0.9.0-dev"), undefined);
			assert.equal(updateFrom(release("v0.8.0"), "0.9.0"), undefined);
			assert.equal(updateFrom(release("v0.9.1", null), "0.9.0"), undefined);
			assert.equal(updateFrom({ tag_name: "v0.9.1", assets: [] }, "0.9.0"), undefined);
		},
	],
];
