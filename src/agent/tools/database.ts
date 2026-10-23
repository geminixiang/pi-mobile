import { Capacitor } from "@capacitor/core";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { Database, type SqlValue, type StatementResult } from "../../database-plugin.ts";
import { defineAppTool, requireNative } from "./common.ts";

function keywords(sql: string): string {
	return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, " ").toUpperCase();
}

const REFUSED = /\b(ATTACH|DETACH)\b|\bVACUUM\s+INTO\b/;

function format(result: StatementResult, index: number): string {
	if (result.columns && result.rows) {
		const header = result.columns.join("\t");
		const rows = result.rows.map((row) => row.map((value) => (value === null ? "NULL" : String(value))).join("\t"));
		return [`#${index + 1}: ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`, header, ...rows].join("\n");
	}
	return `#${index + 1}: ${result.changes ?? 0} changed${result.lastInsertId !== undefined ? `, id ${result.lastInsertId}` : ""}`;
}

const sql = defineAppTool({
	name: "sql",
	description: [
		"Run SQLite statements on the user's own database on the phone, all in one transaction (all apply or none). Keep there what the user wants recorded and counted: expenses, logs, lists, collections.",
		"Use ? placeholders with params rather than pasting values. Queries return their rows; aggregate in SQL (SUM, GROUP BY) or in codemode rather than reading whole tables.",
	].join(" "),
	parameters: Type.Object({
		statements: Type.Array(
			Type.Object({
				sql: Type.String({ description: "One SQL statement" }),
				params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]))),
			}),
			{ minItems: 1 },
		),
	}),
	structuredOutputSchema: Type.Object({
		results: Type.Array(
			Type.Object({
				rows: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])))),
				changes: Type.Optional(Type.Number()),
				last_insert_id: Type.Optional(Type.Number()),
			}),
		),
	}),
	execute: async (args) => {
		requireNative();
		const words = args.statements.map((statement) => keywords(statement.sql));
		if (words.some((word) => REFUSED.test(word))) throw new Error("ATTACH, DETACH, and VACUUM INTO are not allowed: the database is one file");
		const { results } = await Database.execute({ statements: args.statements });
		const structured = results.map((result): JsonValue =>
			result.columns && result.rows
				? {
						rows: result.rows.map((row) =>
							Object.fromEntries((result.columns ?? []).map((column, i): [string, SqlValue] => [column, row[i] ?? null])),
						),
					}
				: { changes: result.changes ?? 0, ...(result.lastInsertId !== undefined ? { last_insert_id: result.lastInsertId } : {}) },
		);
		return { output: [{ type: "text", text: results.map(format).join("\n\n") }], structuredOutput: { results: structured } };
	},
});

export const DatabaseExtension = defineExtension({
	name: "database",
	tools: [sql],
	sections: [
		section("database", async () => {
			if (!Capacitor.isNativePlatform()) return undefined;
			const { tables } = await Database.schema();
			return [
				"sql is the user's SQLite database, shared by their bots: reuse a fitting table, English names, times as YYYY-MM-DD HH:MM, amounts as numbers, a column for what they filter or total by.",
				tables.length > 0 ? `Tables now:\n${tables.map((table) => `${table.sql}; -- ${table.rows} rows`).join("\n")}` : "It has no tables yet.",
			].join("\n");
		}),
	],
});
