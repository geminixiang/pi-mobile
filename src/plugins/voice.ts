import { Type } from "typebox";
import { definePlugin } from "./define.ts";

const Heard = Type.Object({ text: Type.String() });

export const Voice = definePlugin(
	"Voice",
	{
		available: { args: Type.Object({}), result: Type.Object({ available: Type.Boolean() }) },
		start: { args: Type.Object({ language: Type.String() }) },
		stop: { args: Type.Object({}) },
		cancel: { args: Type.Object({}) },
		speak: { args: Type.Object({ text: Type.String(), language: Type.String() }), result: Type.Object({ spoken: Type.Boolean(), reason: Type.Optional(Type.String()) }) },
		stopSpeaking: { args: Type.Object({}) },
	},
	{
		ready: Type.Object({}),
		partial: Heard,
		final: Heard,
		level: Type.Object({ rms: Type.Number() }),
		error: Type.Object({ code: Type.Number(), message: Type.String() }),
		end: Type.Object({}),
	},
);
