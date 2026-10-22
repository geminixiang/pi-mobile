// One IndexedDB object store, opened per operation: the app's few stores are used now and then, so no connection is
// kept open between uses.

export interface IdbStore {
	/** One request, resolving with its result. */
	request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T>;
	/** Several operations in one transaction, resolving when it commits. */
	transaction(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void>;
}

export function idbStore(database: string, store: string, options: IDBObjectStoreParameters = {}): IdbStore {
	const open = () =>
		new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(database, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(store, options);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	const using = async <T>(use: (db: IDBDatabase) => Promise<T>): Promise<T> => {
		const db = await open();
		try {
			return await use(db);
		} finally {
			db.close();
		}
	};
	return {
		request: (mode, run) =>
			using(
				(db) =>
					new Promise((resolve, reject) => {
						const request = run(db.transaction(store, mode).objectStore(store));
						request.onsuccess = () => resolve(request.result);
						request.onerror = () => reject(request.error);
					}),
			),
		transaction: (mode, run) =>
			using(
				(db) =>
					new Promise((resolve, reject) => {
						const transaction = db.transaction(store, mode);
						run(transaction.objectStore(store));
						transaction.oncomplete = () => resolve();
						transaction.onerror = () => reject(transaction.error);
					}),
			),
	};
}
