import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";
import { oneOf } from "../agent/tools/common.ts";

const BotFileInfo = Type.Object({
	name: Type.String(),
	kind: oneOf(["file", "directory"]),
	size: Type.Number(),
	mtimeMs: Type.Number(),
	executable: Type.Boolean(),
});
export type BotFileInfo = Static<typeof BotFileInfo>;

const At = { bot: Type.String(), path: Type.String() };

export const BotFiles = definePlugin("BotFiles", {
	stat: { args: Type.Object(At), result: BotFileInfo },
	exists: { args: Type.Object(At), result: Type.Object({ exists: Type.Boolean() }) },
	create: { args: Type.Object({ ...At, directory: Type.Optional(Type.Boolean()) }) },
	chmod: { args: Type.Object({ ...At, mode: Type.Integer() }) },
	list: { args: Type.Object(At), result: Type.Object({ entries: Type.Array(BotFileInfo) }) },
	read: {
		args: Type.Object({ ...At, offset: Type.Optional(Type.Number()), length: Type.Optional(Type.Number()), text: Type.Optional(Type.Boolean()) }),
		result: Type.Object({ size: Type.Number(), data: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
	},
	write: { args: Type.Object({ ...At, text: Type.Optional(Type.String()), data: Type.Optional(Type.String()), append: Type.Optional(Type.Boolean()) }) },
	truncate: { args: Type.Object({ ...At, size: Type.Number() }) },
	mkdir: { args: Type.Object({ ...At, recursive: Type.Optional(Type.Boolean()) }) },
	remove: { args: Type.Object({ ...At, recursive: Type.Optional(Type.Boolean()), force: Type.Optional(Type.Boolean()) }) },
	rename: { args: Type.Object({ bot: Type.String(), from: Type.String(), to: Type.String() }) },
	removeBot: { args: Type.Object({ bot: Type.String() }) },
	listBots: { args: Type.Object({}), result: Type.Object({ ids: Type.Array(Type.String()) }) },
	download: { args: Type.Object({ ...At, url: Type.String() }), result: Type.Object({ size: Type.Number(), contentType: Type.String(), url: Type.String() }) },
});
