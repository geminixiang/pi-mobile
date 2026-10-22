// What the app keeps for each bot outside pi-durable, by the bot's id (its conversation's): the one list of it, and
// the sweep that removes what belongs to no bot.
//
// | Store                                   | Written by                   | Removed with the bot by   |
// |-----------------------------------------|------------------------------|---------------------------|
// | files/bots/<Bot.folder>                 | read/write/edit/bash         | runtime.removeBot         |
// | IndexedDB pi-attachments, conversationId| attachments.ts               | runtime.removeBot         |
// | localStorage pi-mobile.draft:<id>,      | drafts.ts                    | App (clearDraft)          |
// |   IndexedDB pi-drafts, key <id>         |                              |                           |
// | the sandbox folder <Bot.folder>         | the coding tools, remotely   | runtime.removeBot         |
//
// Folders are named by Bot.folder, a UUID, so they never pass to another bot. Attachments and drafts are kept by the
// conversation id, which pi-durable mints again from the start in a new database: after one (a reinstall, the move
// to IndexedDB) a new bot could get an old one's id and find its draft, so a new database starts with all of them
// removed. Later, the sweep removes what a removal cut short. The sandbox may be shared with other phones, which
// this one cannot tell apart, so it is not swept.
import { attachmentOwners, deleteAttachments } from "../agent/attachments.ts";
import { phoneFolderOwners, removePhoneFolder } from "../agent/files/phone-env.ts";
import { log } from "../log.ts";
import { clearDraft, draftOwners } from "./drafts.ts";

/**
 * Remove what belongs to no bot in `current`, which is read after the owners, so a bot made meanwhile keeps its own.
 * Returns the folders and conversation ids removed.
 */
export async function sweepBotData(current: () => Promise<readonly { id: string; folder: string }[]>): Promise<string[]> {
	const folders = await phoneFolderOwners().catch(() => []);
	const ids = new Set([...(await attachmentOwners().catch(() => [])), ...(await draftOwners().catch(() => []))]);
	const bots = await current();
	const keepFolders = new Set(bots.map((bot) => bot.folder));
	const keepIds = new Set(bots.map((bot) => bot.id));
	const gone: string[] = [];
	for (const folder of folders.filter((name) => !keepFolders.has(name))) {
		await removePhoneFolder(folder).then(
			() => gone.push(folder),
			(error: unknown) => log.warn("bot_data.folder_failed", { folder, error: String(error) }),
		);
	}
	for (const id of [...ids].filter((id) => !keepIds.has(id))) {
		await deleteAttachments({ conversationId: id }).catch((error: unknown) => log.warn("bot_data.attachments_failed", { id, error: String(error) }));
		await clearDraft(id).catch((error: unknown) => log.warn("bot_data.draft_failed", { id, error: String(error) }));
		gone.push(id);
	}
	if (gone.length > 0) log.info("bot_data.swept", { removed: gone.join(",") });
	return gone;
}
