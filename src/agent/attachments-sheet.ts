// Spreadsheet attachments (.xlsx, .csv, .tsv): ChatGPT and Claude compute over tables with code instead of reading
// them, so each sheet is imported into the user's SQLite database (the sql tool), one table a sheet, its first row the
// columns. The rows are also kept as tab-separated text, for small tables inline and for read_attachment.
import { Capacitor } from "@capacitor/core";
import readXlsxFile from "read-excel-file/universal";
import { Database, type SqlValue } from "../database-plugin.ts";

type Cell = string | number | boolean | null;
interface Sheet {
	name: string;
	rows: Cell[][];
}

/** RFC 4180 fields: quotes around fields with the separator, quotes, or line breaks; "" for a quote. */
function parseDelimited(text: string, separator: string): Cell[][] {
	const rows: Cell[][] = [];
	let row: Cell[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"' && field === "") quoted = true;
		else if (char === separator) {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.map((cells) => cells.map((cell) => (typeof cell === "string" && isExactNumber(cell.trim()) ? Number(cell) : cell)));
}

const MAX_EXACT_DIGITS = 15;

function isExactNumber(text: string): boolean {
	return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && text.replace(/[-.]/g, "").replace(/^0+/, "").length <= MAX_EXACT_DIGITS;
}

const cellOf = (value: unknown): Cell => {
	if (value instanceof Date) return value.toISOString().replace(/T00:00:00\.000Z$/, "").replace(/\.000Z$/, "Z");
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	return null;
};

async function readSheets(file: File): Promise<Sheet[]> {
	if (/\.xlsx$/i.test(file.name)) {
		const sheets = await readXlsxFile(file);
		return sheets.map((sheet) => ({ name: sheet.sheet, rows: sheet.data.map((row) => row.map(cellOf)) }));
	}
	const text = (await file.text()).replace(/^\uFEFF/, "");
	return [{ name: "Sheet1", rows: parseDelimited(text, /\.tsv$/i.test(file.name) ? "\t" : ",") }];
}

const isEmpty = (row: Cell[]) => row.every((cell) => cell === null || cell === "");

/** A name SQLite takes without surprises: letters, digits (any script), and underscores. */
const sqlName = (text: string) => text.trim().replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "") || "column";

function columnsOf(header: Cell[]): string[] {
	const taken = new Set<string>();
	return header.map((cell, index) => {
		const base = cell === null || cell === "" ? `column_${index + 1}` : sqlName(String(cell));
		let name = base;
		for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}_${n}`;
		taken.add(name.toLowerCase());
		return name;
	});
}

/** INTEGER or REAL when every value in the column is such a number, else TEXT. */
function typeOf(rows: Cell[][], index: number): string {
	const values = rows.map((row) => row[index]).filter((value) => value !== null && value !== "");
	if (values.length === 0) return "TEXT";
	if (values.every((value) => typeof value === "number" && Number.isInteger(value))) return "INTEGER";
	if (values.every((value) => typeof value === "number")) return "REAL";
	return "TEXT";
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const BATCH = 500;

async function importSheet(table: string, columns: string[], rows: Cell[][]): Promise<void> {
	const definition = columns.map((column, index) => `${quote(column)} ${typeOf(rows, index)}`).join(", ");
	await Database.execute({ statements: [{ sql: `CREATE TABLE ${quote(table)} (${definition})` }] });
	const insert = `INSERT INTO ${quote(table)} VALUES (${columns.map(() => "?").join(", ")})`;
	for (let start = 0; start < rows.length; start += BATCH) {
		await Database.execute({
			statements: rows.slice(start, start + BATCH).map((row) => ({
				sql: insert,
				params: columns.map((_, index): SqlValue | boolean => (row[index] === "" ? null : (row[index] ?? null))),
			})),
		});
	}
}

const tsv = (rows: Cell[][]) => rows.map((row) => row.map((cell) => (cell === null ? "" : String(cell).replace(/[\t\n]/g, " "))).join("\t")).join("\n");

/** The sheets as text, and the tables they became (none outside the app, where there is no database). */
export async function extractSheet(file: File): Promise<{ text: string; tables: { name: string; sheet: string; rows: number; columns: string[] }[] }> {
	const sheets = (await readSheets(file)).map((sheet) => ({ ...sheet, rows: sheet.rows.filter((row) => !isEmpty(row)) })).filter((sheet) => sheet.rows.length > 0);
	const taken = new Set(Capacitor.isNativePlatform() ? (await Database.schema()).tables.map((table) => table.name.toLowerCase()) : []);
	const base = sqlName(file.name.replace(/\.[^.]+$/, ""));
	const tables: { name: string; sheet: string; rows: number; columns: string[] }[] = [];
	const texts: string[] = [];
	for (const sheet of sheets) {
		const [header, ...rows] = sheet.rows;
		const columns = columnsOf(header);
		texts.push(sheets.length > 1 ? `## ${sheet.name}\n${tsv(sheet.rows)}` : tsv(sheet.rows));
		if (!Capacitor.isNativePlatform()) continue;
		let name = sheets.length > 1 ? `${base}_${sqlName(sheet.name)}` : base;
		for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${sheets.length > 1 ? `${base}_${sqlName(sheet.name)}` : base}_${n}`;
		taken.add(name.toLowerCase());
		await importSheet(name, columns, rows);
		tables.push({ name, sheet: sheet.name, rows: rows.length, columns });
	}
	return { text: texts.join("\n\n"), tables };
}
