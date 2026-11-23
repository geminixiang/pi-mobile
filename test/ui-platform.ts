import assert from "node:assert/strict";
import { copy, haptic, installPlatform, onResume, pasted, type UiPlatform } from "pi-mobile-ui/platform";

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
		return () => void heard.push("back stopped");
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

const stopSecond = installPlatform({
	...phone,
	onBack: () => () => void heard.push("second back stopped"),
});
assert.deepEqual(heard.slice(-1), ["back stopped"]);
stopSecond();
assert.deepEqual(heard.slice(-1), ["second back stopped"]);
console.log("ui platform: before the app installs one every verb does nothing; after, haptics, resume and the clipboard go to it, and re-installing cancels the previous back listener");
