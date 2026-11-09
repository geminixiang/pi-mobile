import { defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { appSection } from "../section.ts";
import type { Workplace } from "../workplaces.ts";
import { GH_USAGE } from "./gh-command.ts";

export const SHOWN_AS_FILE =
	"To give the user something to look at or send on (a report, a comparison, a chart, a small tool), write a self-contained .html file after reading the html-page skill. The conversation draws it in place, working, and the user can open and share it: do not link it, name the file, or repeat what it shows; say in a line what to notice.";

const FOLDER = [
	"read, write, edit, and bash work in your own folder on this phone; / is its root and nothing outside it exists, and bash starts there, so todo.md and /todo.md are the same file. It is private and kept across conversations: put there what the user will want as a file, or what is too long for the conversation; short facts go in memory. A file the user names is probably already there: ls before saying it is missing, and work on it with bash rather than reading it whole.",
	SHOWN_AS_FILE,
	`bash runs built-in commands only (cat, ls, find, grep, sed, awk, jq, sort, uniq, wc, head, tail, cut, tr, diff, cp, mv, rm, mkdir, date, xargs, gzip…); no python or other programs: compute with awk or jq. git and gh reach GitHub as the user (gh has ${GH_USAGE}; clone with --depth 1); nothing else reaches the network.`,
].join(" ");

const MISSING = "The computer you were set to work on was removed from the user's settings, so read, write, edit, and bash cannot run anywhere until the user picks a computer for you in your bot panel (電腦). Say so if a task needs them; everything else works.";

export function createFilesExtension(workplace: (conversationId: string) => Workplace | undefined) {
	const kind = (conversationId: unknown) => workplace(String(conversationId))?.kind;
	return defineExtension({
		name: "files",
		sections: [
			appSection("files", 1_500, (input) => (kind(input.conversationId) === "phone" ? FOLDER : undefined), { about: CodingTools.tools ?? [] }),
			appSection("workplace", 400, (input) => (kind(input.conversationId) === "missing" ? MISSING : undefined)),
		],
	});
}
