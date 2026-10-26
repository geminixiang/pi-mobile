import { type Static, Type } from "typebox";
import { definePlugin } from "./define.ts";

const SqlValue = Type.Union([Type.String(), Type.Number(), Type.Null()]);
export type SqlValue = Static<typeof SqlValue>;

const StatementResult = Type.Object({
	columns: Type.Optional(Type.Array(Type.String())),
	rows: Type.Optional(Type.Array(Type.Array(SqlValue))),
	changes: Type.Optional(Type.Number()),
	lastInsertId: Type.Optional(Type.Number()),
});
export type StatementResult = Static<typeof StatementResult>;

const TableInfo = Type.Object({ name: Type.String(), sql: Type.String(), rows: Type.Number() });

export const Database = definePlugin("Database", {
	execute: {
		args: Type.Object({ statements: Type.Array(Type.Object({ sql: Type.String(), params: Type.Optional(Type.Array(Type.Union([SqlValue, Type.Boolean()]))) })) }),
		result: Type.Object({ results: Type.Array(StatementResult) }),
	},
	schema: { args: Type.Object({}), result: Type.Object({ tables: Type.Array(TableInfo) }) },
	export: { args: Type.Object({}) },
});
