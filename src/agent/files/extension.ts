import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Workplace } from "../workplaces.ts";

export const SHOWN_AS_FILE =
	"To give the user something to look at or send on (a report, a comparison, a chart, a small tool), write a self-contained .html file after reading the html-page skill. The app shows it and can share it.";

const FOLDER = [
	"read, write, edit, and bash work in your own folder on this phone; / is its root and nothing outside it exists. It is private and kept across conversations: put there what the user will want as a file, or what is too long for the conversation; short facts go in memory. A file the user names is probably already there: ls before saying it is missing, and work on it with bash rather than reading it whole.",
	SHOWN_AS_FILE,
	"bash runs built-in commands only (cat, ls, find, grep, sed, awk, jq, sort, uniq, wc, head, tail, cut, tr, diff, cp, mv, rm, mkdir, date, xargs, gzip…); no python or other programs, no network: compute with awk or jq.",
].join(" ");

const MISSING = "The computer you were set to work on was removed from the user's settings, so read, write, edit, and bash cannot run anywhere until the user picks a computer for you in your bot panel (電腦). Say so if a task needs them; everything else works.";

const SECTION: Record<Workplace["kind"], string | undefined> = { phone: FOLDER, computer: undefined, missing: MISSING };

export function createFilesExtension(workplace: (conversationId: string) => Workplace | undefined) {
	return defineExtension({
		name: "files",
		sections: [
			section("files", (input) => {
				const place = workplace(String(input.conversationId));
				return place && SECTION[place.kind];
			}),
		],
	});
}
