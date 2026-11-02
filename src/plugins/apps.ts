import { Type } from "typebox";
import { definePlugin } from "./define.ts";

const SharedFile = {
	fileBase64: Type.String(),
	fileName: Type.String(),
	mimeType: Type.String(),
};

export const Apps = definePlugin("Apps", {
	setAlarm: { args: Type.Object({ hour: Type.Integer(), minute: Type.Integer(), label: Type.Optional(Type.String()), days: Type.Optional(Type.Array(Type.Integer())) }) },
	openAlarms: { args: Type.Object({}), opens: "screen" },
	setTimer: { args: Type.Object({ seconds: Type.Integer(), label: Type.Optional(Type.String()) }) },
	composeEmail: { args: Type.Object({ to: Type.Array(Type.String()), subject: Type.Optional(Type.String()), body: Type.String() }), opens: "screen" },
	composeSms: { args: Type.Object({ to: Type.String(), body: Type.String() }), opens: "screen" },
	open: { args: Type.Object({ uri: Type.String() }), opens: "screen" },
	share: {
		args: Type.Object({
			text: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			fileBase64: Type.Optional(SharedFile.fileBase64),
			fileName: Type.Optional(SharedFile.fileName),
			mimeType: Type.Optional(SharedFile.mimeType),
		}),
		opens: "screen",
	},
	openFile: { args: Type.Object(SharedFile), opens: "screen" },
});
