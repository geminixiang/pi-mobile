interface IdbStore {
	request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T>;
	transaction(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void): Promise<void>;
}

export function idbStore(database: string, store: string, options: IDBObjectStoreParameters = {}): IdbStore {
	let opened: Promise<IDBDatabase> | undefined;
	const open = () =>
		(opened ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(database, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(store, options);
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => {
					db.close();
					opened = undefined;
				};
				db.onclose = () => {
					opened = undefined;
				};
				resolve(db);
			};
			request.onerror = () => {
				opened = undefined;
				reject(request.error);
			};
		}));
	return {
		request: async (mode, run) => {
			const db = await open();
			return new Promise((resolve, reject) => {
				const request = run(db.transaction(store, mode).objectStore(store));
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		},
		transaction: async (mode, run) => {
			const db = await open();
			return new Promise((resolve, reject) => {
				const transaction = db.transaction(store, mode);
				run(transaction.objectStore(store));
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
			});
		},
	};
}
