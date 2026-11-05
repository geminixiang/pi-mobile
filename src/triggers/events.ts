import { App } from "@capacitor/app";
import { Value } from "typebox/value";
import type { AgentRuntime, ConversationId } from "../agent/runtime.ts";
import { native } from "../native.ts";
import { QueuedEvent, Triggers } from "./plugin.ts";
import { log } from "../log.ts";
import { releaseIfIdle } from "../keepAlive.ts";
import { messageOf, orLogged, serially } from "../promise.ts";
import { DAY } from "../time.ts";

const RETRY_FOR_MS = DAY;

export type SharedItem = Extract<QueuedEvent, { kind: "share" }>;

export function latestAlarms(events: readonly QueuedEvent[]): { current: QueuedEvent[]; superseded: Extract<QueuedEvent, { kind: "alarm" }>[] } {
	const timed = events.flatMap((event) => (event.kind === "alarm" && event.device === undefined ? [event] : []));
	const superseded = timed.filter((event) => timed.some((other) => other.trigger === event.trigger && (other.at > event.at || (other.at === event.at && other.id > event.id))));
	return { current: events.filter((event) => !superseded.some((old) => old.id === event.id)), superseded };
}

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

async function takeEvents(): Promise<{ events: QueuedEvent[]; unreadable: string[] }> {
	const { events } = await Triggers.events();
	const parsed: QueuedEvent[] = [];
	const unreadable: string[] = [];
	for (const event of events) {
		if (Value.Check(QueuedEvent, event)) {
			parsed.push(event);
			continue;
		}
		const id = typeof event === "object" && event && "id" in event && typeof event.id === "string" ? event.id : undefined;
		if (id) unreadable.push(id);
	}
	return { events: parsed, unreadable };
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
	};
	const inTurn = serially();
	const drain = () =>
		orLogged(
			inTurn(async () => {
				try {
					const queue = await takeEvents();
					const { current, superseded } = latestAlarms(queue.events);
					for (const trigger of new Set(superseded.map((event) => event.trigger))) {
						const missed = superseded.filter((event) => event.trigger === trigger).length;
						log.info("trigger.missed", { trigger, missed });
						await orLogged(runtime.triggers.missed(trigger, missed), "trigger.missed_notice_failed", undefined, { trigger });
					}
					const handled = await deliverEvents({ events: current, unreadable: [...queue.unreadable, ...superseded.map((event) => event.id)] }, handle, async (event, error) => {
						if (event.kind === "alarm") await runtime.triggers.gaveUp(event.trigger, messageOf(error));
					});
					if (handled.length > 0) await Triggers.ack({ ids: handled });
				} finally {
					// why: an alarm starts the native keep-alive service and a 2 h wake lock before pi runs; only an idle release ends them, whatever the event's outcome
					setTimeout(releaseIfIdle, 30_000);
				}
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

export function listenForOpenLinks(onOpen: (conversation: string, item: string | undefined) => void): () => void {
	if (!native.has("Triggers")) return () => undefined;
	const handle = (link: string | undefined) => {
		if (!link?.startsWith("pimobile://open")) return;
		const params = new URL(link).searchParams;
		const conversation = params.get("conversation");
		if (conversation) onOpen(conversation, params.get("item") ?? undefined);
	};
	void App.getLaunchUrl().then((launch) => handle(launch?.url));
	const listener = App.addListener("appUrlOpen", ({ url }) => handle(url));
	return () => void listener.then((h) => h.remove());
}
