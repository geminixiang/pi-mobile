import type { Storage } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";

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
	while ((await isLockHeld(SINGLE_OWNER_LOCK)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
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

export async function openAppStorage(): Promise<{ storage: Storage; isNewDatabase: boolean }> {
	ownerLock ??= acquireOwnerLockForPageLifetime();
	await ownerLock;
	void askToKeepDataUnderStoragePressure();
	const isNewDatabase = !(await indexedDB.databases()).some((database) => database.name === DATABASE);
	return { storage: await IndexedDbStorage.open(DATABASE), isNewDatabase };
}
