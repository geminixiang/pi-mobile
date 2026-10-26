import type { Storage } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { log } from "./log.ts";
import { messageOf, sleep } from "./promise.ts";

const DATABASE = "pi-mobile-bots";
const SINGLE_OWNER_LOCK = "pi-mobile.storage";
const PREVIOUS_OWNER_GRACE_MS = 5000;
const LOCK_POLL_MS = 100;

let ownerLock: Promise<void> | undefined;

async function isLockHeld(name: string): Promise<boolean> {
	const { held = [] } = await navigator.locks.query();
	return held.some((lock) => lock.name === name);
}

async function waitForPreviousOwner(): Promise<void> {
	const deadline = Date.now() + PREVIOUS_OWNER_GRACE_MS;
	while ((await isLockHeld(SINGLE_OWNER_LOCK)) && Date.now() < deadline) await sleep(LOCK_POLL_MS);
}

async function acquireOwnerLockForPageLifetime(): Promise<void> {
	await waitForPreviousOwner();
	const acquired = await new Promise<boolean>((resolve) => {
		void navigator.locks.request(SINGLE_OWNER_LOCK, { ifAvailable: true }, (lock) => {
			resolve(lock !== null);
			return lock === null ? undefined : new Promise<never>(() => undefined);
		});
	});
	if (!acquired) {
		ownerLock = undefined;
		throw new Error("另一個 pi 畫面正在使用資料，請關掉它再開");
	}
}

async function askToKeepDataUnderStoragePressure(): Promise<void> {
	if (!navigator.storage?.persist || (await navigator.storage.persisted())) return;
	await navigator.storage.persist();
}

const SUSPENDED = /without an in-progress transaction/;
const RETRY_MS = [200, 1000, 3000];

async function retried(first: Promise<unknown>, call: () => unknown): Promise<unknown> {
	let attempt = first;
	for (const wait of RETRY_MS) {
		try {
			return await attempt;
		} catch (error) {
			if (!SUSPENDED.test(messageOf(error))) throw error;
			log.warn("storage.retry_after_suspension", { error: messageOf(error), waitMs: wait });
			await sleep(wait);
			attempt = Promise.resolve(call());
		}
	}
	return attempt;
}

// why: WebKit aborts an IndexedDB transaction in flight when it suspends pi going to the background (WebKit bug 202705); every Storage call is one transaction that leaves nothing behind when aborted, so it is retried
export function surviveSuspension(storage: Storage): Storage {
	return new Proxy(storage, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const call = (): unknown => Reflect.apply(value, target, args);
				const first = call();
				return first instanceof Promise ? retried(first, call) : first;
			};
		},
	});
}

export async function openAppStorage(): Promise<{ storage: Storage; isNewDatabase: boolean }> {
	ownerLock ??= acquireOwnerLockForPageLifetime();
	await ownerLock;
	void askToKeepDataUnderStoragePressure();
	const isNewDatabase = !(await indexedDB.databases()).some((database) => database.name === DATABASE);
	return { storage: surviveSuspension(await IndexedDbStorage.open(DATABASE)), isNewDatabase };
}
