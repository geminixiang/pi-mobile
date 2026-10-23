import { registerPlugin } from "@capacitor/core";

export type SqlValue = string | number | null;

export interface StatementResult {
	columns?: string[];
	rows?: SqlValue[][];
	changes?: number;
	lastInsertId?: number;
}

export interface TableInfo {
	name: string;
	sql: string;
	rows: number;
}

export interface DatabasePlugin {
	execute(options: { statements: { sql: string; params?: (SqlValue | boolean)[] }[] }): Promise<{ results: StatementResult[] }>;
	schema(): Promise<{ tables: TableInfo[] }>;
	export(): Promise<void>;
}

export const Database = registerPlugin<DatabasePlugin>("Database");
