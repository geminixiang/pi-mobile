// Durable storage for the app: SQLite through @capacitor-community/sqlite on device, memory in a plain browser.
import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import {
	type SqliteDatabase,
	type SqliteExecutor,
	SqliteStorage,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/** The bots' database. "pi-mobile" held the conversations from before bots; see takeLegacyStorage. */
const DATABASE = "pi-mobile-bots";
const LEGACY_DATABASE = "pi-mobile";

/** Values cross the Capacitor bridge as JSON, so only JSON-representable bindings are supported. */
function bind(params: SqliteValue[]): (string | number | null)[] {
	return params.map((value) => {
		if (value === null || typeof value === "string" || typeof value === "number") return value;
		if (typeof value === "bigint") {
			if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
				throw new RangeError(`Cannot bind ${value} across the Capacitor bridge without losing precision`);
			}
			return Number(value);
		}
		throw new TypeError("BLOB bindings are not supported by the Capacitor SQLite adapter");
	});
}

/** iOS prepends a row naming the columns; drop it so both platforms return plain rows. */
function rows<T>(values: unknown[] | undefined): T[] {
	return (values ?? []).filter((row) => !(row && typeof row === "object" && "ios_columns" in row)) as T[];
}

/** Runs one operation at a time; a transaction holds the queue until it settles. */
class SerialQueue {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

/**
 * Executes against the plugin connection. Each call passes `transaction: false`: the plugin otherwise wraps every
 * statement in its own transaction, which would nest inside ours.
 */
class Executor implements SqliteExecutor {
	protected readonly db: SQLiteDBConnection;

	constructor(db: SQLiteDBConnection) {
		this.db = db;
	}

	protected check(): void {}

	async exec(sql: string): Promise<void> {
		this.check();
		await this.db.execute(sql, false);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		this.check();
		await this.db.run(sql, bind(params), false);
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return (await this.all<T>(sql, ...params))[0];
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		this.check();
		return rows<T>((await this.db.query(sql, bind(params))).values);
	}
}

class Transaction extends Executor {
	active = true;

	protected override check(): void {
		if (!this.active) throw new Error("SQLite transaction handle is no longer active");
	}
}

export class CapacitorSqliteDatabase implements SqliteDatabase {
	readonly #db: SQLiteDBConnection;
	readonly #direct: Executor;
	readonly #queue = new SerialQueue();
	readonly #onClose: () => Promise<void>;

	constructor(db: SQLiteDBConnection, onClose: () => Promise<void>) {
		this.#db = db;
		this.#direct = new Executor(db);
		this.#onClose = onClose;
	}

	exec(sql: string): Promise<void> {
		return this.#queue.run(() => this.#direct.exec(sql));
	}

	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.#queue.run(() => this.#direct.run(sql, ...params));
	}

	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#queue.run(() => this.#direct.get<T>(sql, ...params));
	}

	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#queue.run(() => this.#direct.all<T>(sql, ...params));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queue.run(async () => {
			await this.#db.beginTransaction();
			const transaction = new Transaction(this.#db);
			let result: T;
			try {
				result = await callback(transaction);
			} catch (error) {
				transaction.active = false;
				try {
					await this.#db.rollbackTransaction();
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite rollback failed");
				}
				throw error;
			}
			transaction.active = false;
			await this.#db.commitTransaction();
			return result;
		});
	}

	close(): Promise<void> {
		return this.#queue.run(this.#onClose);
	}
}

async function openDatabase(sqlite: SQLiteConnection, name: string): Promise<{ storage: Storage; db: SQLiteDBConnection }> {
	// A WebView reload keeps native connections alive; reuse instead of failing on a duplicate.
	const existing = (await sqlite.isConnection(name, false)).result;
	const db = existing ? await sqlite.retrieveConnection(name, false) : await sqlite.createConnection(name, false, "no-encryption", 1, false);
	await db.open();
	// WAL and NORMAL sync: commits survive an app kill, matching pi-durable's Node SQLite settings.
	// PRAGMAs that return a row must go through query() on Android.
	await db.query("PRAGMA journal_mode = WAL").catch(() => undefined);
	await db.execute("PRAGMA synchronous = NORMAL", false).catch(() => undefined);
	const database = new CapacitorSqliteDatabase(db, async () => {
		await db.close();
		await sqlite.closeConnection(name, false);
	});
	return { storage: await SqliteStorage.open(database), db };
}

export async function openAppStorage(): Promise<{ storage: Storage; kind: "sqlite" | "memory" }> {
	if (!Capacitor.isNativePlatform()) return { storage: new MemoryStorage(), kind: "memory" };
	const sqlite = new SQLiteConnection(CapacitorSQLite);
	await sqlite.checkConnectionsConsistency().catch(() => undefined);
	return { storage: (await openDatabase(sqlite, DATABASE)).storage, kind: "sqlite" };
}

/**
 * The database from before bots, if it is still there: the caller reads what it keeps (the global MEMORY.md), then
 * calls `discard`, which deletes it with every old conversation.
 */
export async function takeLegacyStorage(): Promise<{ storage: Storage; discard: () => Promise<void> } | undefined> {
	if (!Capacitor.isNativePlatform()) return undefined;
	const sqlite = new SQLiteConnection(CapacitorSQLite);
	if (!(await sqlite.isDatabase(LEGACY_DATABASE)).result) return undefined;
	const { storage, db } = await openDatabase(sqlite, LEGACY_DATABASE);
	return {
		storage,
		discard: async () => {
			await db.delete();
			await sqlite.closeConnection(LEGACY_DATABASE, false).catch(() => undefined);
		},
	};
}
