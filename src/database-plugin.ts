// DatabasePlugin on Android: the user's SQLite database (DatabasePlugin.java), for the sql tool and settings.
import { registerPlugin } from "@capacitor/core";

export type SqlValue = string | number | null;

export interface StatementResult {
	/** Queries: column names and rows. */
	columns?: string[];
	rows?: SqlValue[][];
	/** Other statements: rows changed, and the new row's id for an INSERT. */
	changes?: number;
	lastInsertId?: number;
}

export interface TableInfo {
	name: string;
	/** Its CREATE TABLE statement. */
	sql: string;
	rows: number;
}

export interface DatabasePlugin {
	/** All statements in one transaction: all apply or none. */
	execute(options: { statements: { sql: string; params?: (SqlValue | boolean)[] }[] }): Promise<{ results: StatementResult[] }>;
	schema(): Promise<{ tables: TableInfo[] }>;
	/** The share sheet with a copy of the database file. */
	export(): Promise<void>;
}

export const Database = registerPlugin<DatabasePlugin>("Database");
