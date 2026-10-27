import { App } from "@capacitor/app";
import { type Static, Type } from "typebox";
import { parse } from "../agent/parse.ts";
import { System } from "../plugins/system.ts";
import { codeOf, messageOf, untilFailure } from "../promise.ts";

const LATEST_RELEASE = "https://api.github.com/repos/geminixiang/pi-mobile/releases/latest";

const Release = Type.Object({
	tag_name: Type.String(),
	assets: Type.Array(
		Type.Object({ name: Type.String(), browser_download_url: Type.String(), digest: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
	),
});
export type Release = Static<typeof Release>;

export type Update = { version: string; url: string; sha256: string };

const REFUSED: Record<string, string> = {
	checksum: "下載的檔案跟 GitHub 上的不一樣，沒有安裝",
	not_this_app: "下載的不是 pi mobile，沒有安裝",
	other_key: "新版和這支手機上的 pi mobile 用不同的金鑰簽章，要先移除再安裝",
};

export const checkForUpdate = untilFailure(async (): Promise<Update | undefined> => {
	const installed = (await App.getInfo()).version;
	const response = await fetch(LATEST_RELEASE, { headers: { Accept: "application/vnd.github+json" } });
	if (!response.ok) throw new Error(`GitHub 回 HTTP ${response.status}`);
	return updateFrom(parse(Release, await response.json(), "GitHub 的版本資訊"), installed);
});

export function updateFrom(release: Release, installed: string): Update | undefined {
	const version = release.tag_name.replace(/^v/, "");
	if (!isNewer(version, installed)) return undefined;
	const apk = release.assets.find((asset) => asset.name === `pi-mobile-${version}.apk`);
	const sha256 = /^sha256:([0-9a-f]{64})$/.exec(apk?.digest ?? "")?.[1];
	return apk && sha256 ? { version, url: apk.browser_download_url, sha256 } : undefined;
}

export async function installUpdate(update: Update): Promise<void> {
	try {
		await System.installUpdate({ url: update.url, sha256: update.sha256 });
	} catch (error) {
		throw new Error(REFUSED[codeOf(error) ?? ""] ?? `下載失敗：${messageOf(error)}`);
	}
}

function isNewer(version: string, installed: string): boolean {
	const parts = (text: string) => text.split(/[.-]/).slice(0, 3).map(Number);
	const theirs = parts(version);
	const ours = parts(installed);
	const difference = theirs.map((part, index) => part - (ours[index] ?? 0)).find((delta) => delta !== 0) ?? 0;
	return difference > 0;
}
