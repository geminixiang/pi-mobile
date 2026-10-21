// sql: the user's own SQLite database on the phone, shared by the bots that have the 資料庫 toolset. Bots keep there
// whatever structured records the user wants kept and counted (expenses, a reading list, a weight log), in tables
// they design. The prompt lists the tables, so a bot reuses one another bot made instead of starting its own.
//
// Statements that delete data (DROP, DELETE) ask the user first; creating, inserting, and updating do not. ATTACH,
// DETACH, and VACUUM INTO are refused: they would reach files outside the database.
import { Capacitor } from "@capacitor/core";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Database, type SqlValue, type StatementResult } from "../../database-plugin.ts";
import { requestConfirmation } from "../confirm.ts";

/** The statement's words outside string literals, quoted names, and comments, upper-cased. */
function keywords(sql: string): string {
	return sql
		.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, " ")
		.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
		.toUpperCase();
}

const DESTRUCTIVE = /\b(DROP|DELETE)\b/;
const REFUSED = /\b(ATTACH|DETACH)\b|\bVACUUM\s+INTO\b/;

function format(result: StatementResult, index: number): string {
	if (result.columns && result.rows) {
		const header = result.columns.join("\t");
		const rows = result.rows.map((row) => row.map((value) => (value === null ? "NULL" : String(value))).join("\t"));
		return [`#${index + 1}: ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`, header, ...rows].join("\n");
	}
	return `#${index + 1}: ${result.changes ?? 0} changed${result.lastInsertId !== undefined ? `, id ${result.lastInsertId}` : ""}`;
}

const sql = defineTool({
	name: "sql",
	description: [
		"Run SQLite statements on the user's own database on the phone, all in one transaction (all apply or none). Keep there what the user wants recorded and counted: expenses, logs, lists, collections.",
		"Use ? placeholders with params rather than pasting values. Queries return their rows; aggregate in SQL (SUM, GROUP BY) or in codemode rather than reading whole tables.",
		"DROP and DELETE ask the user first.",
	].join(" "),
	parameters: Type.Object({
		statements: Type.Array(
			Type.Object({
				sql: Type.String({ description: "One SQL statement" }),
				params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]))),
			}),
			{ minItems: 1 },
		),
		reason: Type.Optional(Type.String({ description: "For DROP or DELETE: one sentence shown to the user in the confirmation dialog" })),
	}),
	// Scripts get each query's rows as objects keyed by column.
	structuredOutputSchema: Type.Object({
		results: Type.Array(
			Type.Object({
				rows: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])))),
				changes: Type.Optional(Type.Number()),
				lastInsertId: Type.Optional(Type.Number()),
			}),
		),
	}),
	execute: async (args) => {
		if (!Capacitor.isNativePlatform()) throw new Error("only available in the Android app");
		const words = args.statements.map((statement) => keywords(statement.sql));
		if (words.some((word) => REFUSED.test(word))) throw new Error("ATTACH, DETACH, and VACUUM INTO are not allowed: the database is one file");
		if (words.some((word) => DESTRUCTIVE.test(word))) {
			const approved = await requestConfirmation({
				title: "刪除資料庫裡的資料",
				detail: [args.reason, ...args.statements.map((statement) => `${statement.sql}${statement.params?.length ? `\n  ${JSON.stringify(statement.params)}` : ""}`)]
					.filter(Boolean)
					.join("\n\n"),
			});
			if (!approved) {
				throw new Error("The user declined. Reply with one short sentence that nothing was deleted, such as 「好，不刪。」; do not list what it would have been, offer alternatives, or ask why.");
			}
		}
		const { results } = await Database.execute({ statements: args.statements });
		const structured = results.map((result): JsonValue =>
			result.columns && result.rows
				? {
						rows: result.rows.map((row) =>
							Object.fromEntries((result.columns ?? []).map((column, i): [string, SqlValue] => [column, row[i] ?? null])),
						),
					}
				: { changes: result.changes ?? 0, ...(result.lastInsertId !== undefined ? { lastInsertId: result.lastInsertId } : {}) },
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
			const { tables } = await Database.schema().catch(() => ({ tables: [] }));
			return [
				"The user's SQLite database (the sql tool) keeps structured records for them and their other bots. Reuse a table that fits before creating one; name tables and columns in English, keep the user's text as they wrote it; store times as ISO text (YYYY-MM-DD HH:MM, local) and amounts as numbers with a currency column when it can vary. Give what the user will filter or total by its own column (for expenses: category, payment method), not only free text; ALTER TABLE ADD COLUMN when a table lacks one.",
				tables.length > 0 ? `Tables now:\n${tables.map((table) => `${table.sql}; -- ${table.rows} rows`).join("\n")}` : "It has no tables yet.",
			].join("\n");
		}),
	],
});
