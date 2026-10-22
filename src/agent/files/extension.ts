// What a bot's model is told about its folder on the phone, when there is no sandbox: the coding tools (read, write,
// edit, bash) then work there (phone-env.ts).
import { defineExtension, section } from "@earendil-works/pi-durable";

const FOLDER = [
	"read, write, edit, and bash work in your own folder on this phone; / is its root and nothing outside it exists. It is private and kept across conversations: put there what the user will want as a file, or what is too long for the conversation; short facts go in memory.",
	"bash runs built-in commands only (cat, ls, find, grep, sed, awk, jq, sort, uniq, wc, head, tail, cut, tr, diff, cp, mv, rm, mkdir, date, xargs…); no other programs, no network.",
].join(" ");

export const FilesExtension = defineExtension({
	name: "files",
	sections: [section("files", () => FOLDER)],
});
