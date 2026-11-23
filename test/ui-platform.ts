import assert from "node:assert/strict";
import { copy, pasted } from "../src/ui/clipboard.ts";
import { haptic } from "../src/ui/haptics.ts";
import { installPlatform, type UiPlatform } from "../src/ui/platform.ts";
import { onResume } from "../src/ui/resume.ts";

haptic("tick");
onResume(() => assert.fail("nothing resumes before a platform is installed"))();
await copy("lost");
assert.equal(await pasted(), "");

const heard: string[] = [];
const backs: (() => boolean)[] = [];
const phone: UiPlatform = {
	haptic: (kind) => void heard.push(`haptic ${kind}`),
	onBack: (taken) => {
		backs.push(taken);
		return () => undefined;
	},
	onResume: (run) => {
		run();
		return () => void heard.push("resume stopped");
	},
	copy: async (text) => void heard.push(`copy ${text}`),
	pasted: async () => "from the phone",
};
installPlatform(phone);
assert.equal(backs.length, 1);

haptic("confirm");
const resumes: number[] = [];
onResume(() => resumes.push(1))();
await copy("kept");
assert.equal(await pasted(), "from the phone");
assert.deepEqual(heard, ["haptic confirm", "resume stopped", "copy kept"]);
assert.deepEqual(resumes, [1]);
console.log("ui platform: before the app installs one every verb does nothing; after, haptics, resume and the clipboard go to it, and the back key is listened for once");
