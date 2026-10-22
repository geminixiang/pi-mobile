// What the app keeps for each bot outside pi-durable, by the bot's id (its conversation's): the one list of it, and
// the sweep that removes what belongs to no bot.
//
// | Store                                   | Written by                   | Removed with the bot by   |
// |-----------------------------------------|------------------------------|---------------------------|
// | files/bots/<id> (BotFilesPlugin.java)   | read/write/edit/bash         | runtime.removeBot         |
// | IndexedDB pi-attachments, conversationId| attachments.ts               | runtime.removeBot         |
// | localStorage pi-mobile.draft:<id>,      | drafts.ts                    | App (clearDraft)          |
// |   IndexedDB pi-drafts, key <id>         |                              |                           |
// | the sandbox folder (bot.folder, by name)| the coding tools, remotely   | runtime.removeBot         |
//
// pi-durable mints ids from the start in a new database, so after one (a reinstall, the move to IndexedDB) a new bot
// can get the id of an old one and would find its files and draft: a new database starts with all of them removed.
// Later, the sweep removes what a removal cut short. The sandbox folders are on the user's machine and named, not
// numbered; they are not swept.
import { attachmentOwners, deleteAttachments } from "../agent/attachments.ts";
import { phoneFolderOwners, removePhoneFolder } from "../agent/files/phone-env.ts";
import { log } from "../log.ts";
import { clearDraft, draftOwners } from "./drafts.ts";

/** Remove the data of every bot not in `current`, which is read after the owners, so a bot made meanwhile keeps its own. */
export async function sweepBotData(current: () => Promise<readonly string[]>): Promise<string[]> {
	const owners = new Set([...(await phoneFolderOwners().catch(() => [])), ...(await attachmentOwners().catch(() => [])), ...(await draftOwners().catch(() => []))]);
	const keep = new Set(await current());
	const gone = [...owners].filter((id) => !keep.has(id));
	for (const id of gone) {
		await removePhoneFolder(id).catch((error: unknown) => log.warn("bot_data.folder_failed", { id, error: String(error) }));
		await deleteAttachments({ conversationId: id }).catch((error: unknown) => log.warn("bot_data.attachments_failed", { id, error: String(error) }));
		await clearDraft(id).catch((error: unknown) => log.warn("bot_data.draft_failed", { id, error: String(error) }));
	}
	if (gone.length > 0) log.info("bot_data.swept", { bots: gone.join(",") });
	return gone;
}
