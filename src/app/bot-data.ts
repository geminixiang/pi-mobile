import { attachmentOwners, deleteAttachments } from "../agent/attachments.ts";
import { phoneFolderOwners, removePhoneFolder } from "../agent/files/phone-env.ts";
import { log } from "../log.ts";
import { clearDraft, draftOwners } from "./drafts.ts";
import { orLogged } from "../promise.ts";

export async function sweepBotData(current: () => Promise<readonly { id: string; folder: string }[]>): Promise<string[]> {
	const folders = await orLogged(phoneFolderOwners(), "bot_data.folders_unreadable", []);
	const ids = new Set([...(await orLogged(attachmentOwners(), "bot_data.attachments_unreadable", [])), ...(await orLogged(draftOwners(), "bot_data.drafts_unreadable", []))]);
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
		await orLogged(deleteAttachments({ conversationId: id }), "bot_data.attachments_failed", undefined, { id });
		await orLogged(clearDraft(id), "bot_data.draft_failed", undefined, { id });
		gone.push(id);
	}
	if (gone.length > 0) log.info("bot_data.swept", { removed: gone.join(",") });
	return gone;
}
