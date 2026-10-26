import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";

const Contact = Type.Object({
	name: Type.String(),
	starred: Type.Optional(Type.Boolean()),
	company: Type.Optional(Type.String()),
	birthday: Type.Optional(Type.String()),
	phones: Type.Array(Type.Object({ number: Type.String(), type: Type.String() })),
	emails: Type.Array(Type.String()),
});
export type Contact = Static<typeof Contact>;

export const Contacts = definePlugin("Contacts", {
	search: { args: Type.Object({ query: Type.Optional(Type.String()) }), result: Type.Object({ items: Type.Array(Contact) }) },
});
