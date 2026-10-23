// Durable storage for the app: IndexedDB, in the WebView itself. Measured against SQLite through
// @capacitor-community/sqlite (2026-10-22, emulator): starting the app made 73 bridge calls in a row, about 2 s before
// a conversation showed (2.1-6.2 s), against 0.6 s with IndexedDB. SQLite stays only to read the database from before
// bots (v0.1.0; takeLegacyStorage).
import { Capacitor } from "@capacitor/core";
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import {
	type SqliteDatabase,
	type SqliteExecutor,
	SqliteStorage,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/** The bots' IndexedDB database. "pi-mobile" (SQLite) held the conversations from before bots; see takeLegacyStorage. */
const DATABASE = "pi-mobile-bots";
const LEGACY_DATABASE = "pi-mobile";
/** IndexedDbStorage needs one owner: a second WebView of the app (the assistant once opened one) must not open it too. */
const OWNER_LOCK = "pi-mobile.storage";
/** How long a start waits for another owner to let go (a reload releases the lock as the old page goes). */
const OWNER_WAIT_MS = 5000;

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

class CapacitorSqliteDatabase implements SqliteDatabase {
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

/** Hold the owner lock for the page's life; rejects when another owner keeps it past OWNER_WAIT_MS. */
/** Held from the first open until the page goes: a later open in the same page (settings restart the runtime) has it. */
let ownerLock: Promise<void> | undefined;

function holdOwnerLock(): Promise<void> {
	ownerLock ??= new Promise<void>((resolve, reject) => {
		navigator.locks
			.request(OWNER_LOCK, { signal: AbortSignal.timeout(OWNER_WAIT_MS) }, () => {
				resolve();
				// Never settles: the lock goes with the page.
				return new Promise<never>(() => undefined);
			})
			.catch(() => reject(new Error("另一個 pi 畫面正在使用資料，請關掉它再開")));
	});
	ownerLock.catch(() => {
		ownerLock = undefined;
	});
	return ownerLock;
}

/** The app's storage. `fresh` when the database did not exist: the bots' other data (bot-data.ts) is then from one that is gone. */
export async function openAppStorage(): Promise<{ storage: Storage; fresh: boolean }> {
	await holdOwnerLock();
	// Best effort: the WebView answers false, and keeps the data unless the app's data is cleared.
	void navigator.storage?.persist?.().catch(() => false);
	const fresh = !(await indexedDB.databases()).some((database) => database.name === DATABASE);
	return { storage: await IndexedDbStorage.open(DATABASE), fresh };
}

/**
 * The database from before bots, if it is still there: the caller reads what it keeps (the global MEMORY.md), then
 * calls `discard`, which deletes it with every old conversation.
 */
export async function takeLegacyStorage(): Promise<{ storage: Storage; discard: () => Promise<void> } | undefined> {
	if (!Capacitor.isNativePlatform()) return undefined;
	const sqlite = new SQLiteConnection(CapacitorSQLite);
	if (!(await sqlite.isDatabase(LEGACY_DATABASE)).result) return undefined;
	const { storage } = await openDatabase(sqlite, LEGACY_DATABASE);
	return {
		storage,
		discard: async () => {
			const connection = (await sqlite.isConnection(LEGACY_DATABASE, false)).result
				? await sqlite.retrieveConnection(LEGACY_DATABASE, false)
				: await sqlite.createConnection(LEGACY_DATABASE, false, "no-encryption", 1, false);
			await connection.open();
			await connection.delete();
			await sqlite.closeConnection(LEGACY_DATABASE, false).catch(() => undefined);
		},
	};
}
