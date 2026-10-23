import { defineExtension, section } from "@earendil-works/pi-durable";

const FOLDER = [
	"read, write, edit, and bash work in your own folder on this phone; / is its root and nothing outside it exists. It is private and kept across conversations: put there what the user will want as a file, or what is too long for the conversation; short facts go in memory.",
	"bash runs built-in commands only (cat, ls, find, grep, sed, awk, jq, sort, uniq, wc, head, tail, cut, tr, diff, cp, mv, rm, mkdir, date, xargs, gzip…); no python or other programs, no network: compute with awk or jq.",
].join(" ");

const MISSING = "The computer you were set to work on was removed from the user's settings, so read, write, edit, and bash cannot run anywhere until the user picks a computer for you in your bot panel (電腦). Say so if a task needs them; everything else works.";

export type Workplace = "phone" | "computer" | "missing";

const SECTION: Record<Workplace, string | undefined> = { phone: FOLDER, computer: undefined, missing: MISSING };

export function createFilesExtension(workplace: (conversationId: string) => Workplace) {
	return defineExtension({
		name: "files",
		sections: [section("files", (input) => SECTION[workplace(String(input.conversationId))])],
	});
}
