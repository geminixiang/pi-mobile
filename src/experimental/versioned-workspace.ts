/** Opt-in, text-only WebView PoC. No app data or agent tools are wired to this store. */
type Tree = Record<string, string>;
interface Commit { tree: Tree; parent: string | null; message: string }
interface Workspace { base: string; changes: Record<string, string | null> }
interface State {
	blobs: Record<string, string>;
	commits: Record<string, Commit>;
	branches: Record<string, string>;
	workspaces: Record<string, Workspace>;
	receipts: Record<string, { request: string; commit: string }>;
}
const empty = (): State => ({
	blobs: {}, commits: { root: { tree: {}, parent: null, message: "Initial snapshot" } },
	branches: { main: "root" }, workspaces: {}, receipts: {},
});
function own<T>(record: Record<string, T>, key: string): T {
	if (!Object.hasOwn(record, key)) throw new Error(`Not found: ${key}`);
	return record[key];
}
function name(value: string): void {
	if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) {
		throw new Error("Invalid name");
	}
}
function path(value: string): void {
	if (!value.startsWith("/") || value === "/" || value.includes("\0") || value.split("/").slice(1).some(p => !p || p === "." || p === "..")) {
		throw new Error("Expected canonical absolute file path");
	}
}
export class WorkspaceConflict extends Error {
	readonly paths: string[];
	constructor(paths: string[]) { super(`Conflicting paths: ${paths.join(", ")}`); this.paths = paths; }
}
/** One record intentionally bounds implementation complexity, not memory/storage usage. */
export class VersionedWorkspaceStore {
	private readonly db: IDBDatabase;
	private constructor(db: IDBDatabase) { this.db = db; }

	static async open(databaseName = "pi-versioned-workspace-poc", factory: IDBFactory = indexedDB): Promise<VersionedWorkspaceStore> {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(databaseName, 1);
			request.onupgradeneeded = () => request.result.createObjectStore("state");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
			request.onblocked = () => reject(new Error("Database upgrade blocked; close other clients"));
		});
		db.onversionchange = () => db.close();
		return new VersionedWorkspaceStore(db);
	}

	close(): void { this.db.close(); }

	// No await inside the transaction: independent connections serialize read-modify-write.
	private transact<T>(write: boolean, action: (state: State) => T): Promise<T> {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction("state", write ? "readwrite" : "readonly");
			const store = tx.objectStore("state");
			const request = store.get("root");
			let result: T;
			let failure: unknown;
			request.onsuccess = () => {
				try {
					const state: State = request.result ?? empty();
					result = action(state);
					if (write) store.put(state, "root");
				} catch (error) { failure = error; tx.abort(); }
			};
			tx.oncomplete = () => resolve(result);
			tx.onabort = () => reject(failure ?? tx.error ?? new Error("Transaction aborted"));
			tx.onerror = () => { /* onabort reports request and quota errors */ };
		});
	}

	async head(branch = "main"): Promise<string> {
		return this.transact(false, s => own(s.branches, branch));
	}

	async fork(branch: string, fromCommit: string): Promise<void> {
		name(branch);
		return this.transact(true, s => {
			own(s.commits, fromCommit);
			if (Object.hasOwn(s.branches, branch)) throw new Error("Branch exists");
			s.branches[branch] = fromCommit;
		});
	}

	async workspace(id: string, branch = "main"): Promise<void> {
		name(id);
		return this.transact(true, s => {
			if (Object.hasOwn(s.workspaces, id)) throw new Error("Workspace exists");
			s.workspaces[id] = { base: own(s.branches, branch), changes: {} };
		});
	}

	async write(id: string, file: string, content: string | null): Promise<void> {
		path(file);
		const hash = content === null ? null : Array.from(new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)),
		), b => b.toString(16).padStart(2, "0")).join("");
		return this.transact(true, s => {
			const ws = own(s.workspaces, id);
			if (hash !== null) s.blobs[hash] = content!;
			ws.changes[file] = hash;
		});
	}

	async read(id: string, file: string): Promise<string | null> {
		path(file);
		return this.transact(false, s => {
			const ws = own(s.workspaces, id);
			const hash = Object.hasOwn(ws.changes, file) ? ws.changes[file] : own(s.commits, ws.base).tree[file];
			return hash == null ? null : own(s.blobs, hash);
		});
	}

	/** Publish workspace changes onto a target branch with a three-way, whole-file merge.
	 * Receipt replay returns the original result even if the workspace has since changed.
	 * Callers must assign a fresh operationId for each intended commit.
	 */
	async commit(id: string, target: string, operationId: string, message = ""): Promise<string> {
		name(operationId);
		const request = JSON.stringify([id, target, message]);
		return this.transact(true, s => {
			if (Object.hasOwn(s.receipts, operationId)) {
				const receipt = s.receipts[operationId];
				if (receipt.request !== request) throw new Error("Operation ID reused for another request");
				return receipt.commit;
			}
			const ws = own(s.workspaces, id);
			const head = own(s.branches, target);
			const base = own(s.commits, ws.base).tree;
			const current = own(s.commits, head).tree;
			const tree = { ...current };
			const conflicts: string[] = [];
			for (const [file, value] of Object.entries(ws.changes)) {
				const before = base[file] ?? null;
				const now = current[file] ?? null;
				if (value === before) continue;
				if (now !== before && now !== value) { conflicts.push(file); continue; }
				if (value === null) delete tree[file];
				else tree[file] = value;
			}
			if (conflicts.length) throw new WorkspaceConflict(conflicts.sort());
			const commit = crypto.randomUUID();
			s.commits[commit] = { tree, parent: head, message };
			s.branches[target] = commit;
			ws.base = commit;
			ws.changes = {};
			s.receipts[operationId] = { request, commit };
			return commit;
		});
	}

	async diff(left: string, right: string): Promise<string[]> {
		return this.transact(false, s => {
			const a = own(s.commits, left).tree, b = own(s.commits, right).tree;
			return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(p => a[p] !== b[p]).sort();
		});
	}
}
