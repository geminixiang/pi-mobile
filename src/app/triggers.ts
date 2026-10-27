import { App } from "@capacitor/app";
import type { AgentRuntime, ConversationId } from "../agent/runtime.ts";
import { takeEvents } from "../agent/triggers.ts";
import { native } from "../native.ts";
import { type QueuedEvent, Triggers } from "../plugins/triggers.ts";
import { log } from "../log.ts";
import { releaseIfIdle } from "./keepAlive.ts";
import { messageOf, orLogged, serially } from "../promise.ts";
import { DAY } from "../agent/tools/common.ts";

const RETRY_FOR_MS = DAY;

export type SharedItem = Extract<QueuedEvent, { kind: "share" }>;

export async function deliverEvents(
	queue: { events: readonly QueuedEvent[]; unreadable: readonly string[] },
	handle: (event: QueuedEvent) => Promise<void>,
	drop: (event: QueuedEvent, error: unknown) => Promise<void>,
	now = Date.now(),
): Promise<string[]> {
	const handled = [...queue.unreadable];
	for (const event of queue.events) {
		const trigger = event.kind === "alarm" ? event.trigger : "";
		try {
			await handle(event);
			handled.push(event.id);
		} catch (error) {
			const expired = now - event.at > RETRY_FOR_MS;
			log.warn(expired ? "trigger.dropped" : "trigger.retry_later", { id: event.id, kind: event.kind, trigger, at: event.at, error: messageOf(error) });
			if (!expired) continue;
			await orLogged(drop(event, error), "trigger.drop_failed", undefined, { id: event.id });
			handled.push(event.id);
		}
	}
	return handled;
}

export function processTriggerEvents(
	runtime: AgentRuntime,
	handlers: {
		onShare: (item: SharedItem) => Promise<void>;
		onOpened: (conversation: ConversationId) => void;
	},
): () => void {
	if (!native.implements(Triggers.events)) return () => undefined;
	const handle = async (event: QueuedEvent) => {
		if (event.kind !== "alarm") return handlers.onShare(event);
		const conversation = await runtime.triggers.run(event.trigger, event.live ? "live" : "later", { event: event.id, ...(event.device ? { device: event.device } : {}) });
		log.info("trigger.run", { id: event.id, trigger: event.trigger, live: event.live, delayMs: Date.now() - event.at, conversation: conversation ?? "none" });
		await Triggers.started({ trigger: event.trigger });
		if (!event.live && conversation) handlers.onOpened(conversation);
		setTimeout(releaseIfIdle, 30_000);
	};
	const inTurn = serially();
	const drain = () =>
		orLogged(
			inTurn(async () => {
				const handled = await deliverEvents(await takeEvents(), handle, async (event, error) => {
					if (event.kind === "alarm") await runtime.triggers.gaveUp(event.trigger, messageOf(error));
				});
				if (handled.length > 0) await Triggers.ack({ ids: handled });
			}),
			"trigger.drain_failed",
			undefined,
		);
	void drain();
	const event = Triggers.addListener("event", () => void drain());
	const state = App.addListener("appStateChange", ({ isActive }) => {
		if (isActive) void drain();
	});
	return () => {
		void event.then((handle) => handle.remove());
		void state.then((handle) => handle.remove());
	};
}

export function listenForOpenLinks(onOpen: (conversation: string) => void): () => void {
	if (!native.has("Triggers")) return () => undefined;
	const handle = (link: string | undefined) => {
		if (!link?.startsWith("pimobile://open")) return;
		const conversation = new URL(link).searchParams.get("conversation");
		if (conversation) onOpen(conversation);
	};
	void App.getLaunchUrl().then((launch) => handle(launch?.url));
	const listener = App.addListener("appUrlOpen", ({ url }) => handle(url));
	return () => void listener.then((h) => h.remove());
}
