// The app side of triggers: take queued native events (fired schedules, shares from other apps) when the runtime is
// ready, and open conversations from notification taps.
import { App } from "@capacitor/app";
import type { AgentRuntime, ConversationId } from "../agent/runtime.ts";
import { nativeTriggers, type QueuedEvent, takeEvents, Triggers } from "../agent/triggers.ts";
import { log } from "../log.ts";
import { releaseIfIdle } from "./keepAlive.ts";

export type SharedItem = Extract<QueuedEvent, { kind: "share" }>;

/**
 * Handle queued events now, whenever the native side announces more, and when pi comes to the front. Runs one pass
 * at a time, and acknowledges each event only after it was handled, so an event is never handled twice or lost.
 */
export function processTriggerEvents(
	runtime: AgentRuntime,
	handlers: {
		onShare: (item: SharedItem) => Promise<void>;
		/** A run the user started by opening pi from its notification: show its conversation. */
		onOpened: (conversation: ConversationId) => void;
	},
): () => void {
	if (!nativeTriggers) return () => undefined;
	let pass = Promise.resolve();
	const drain = () => {
		pass = pass.then(async () => {
			const { events, unreadable } = await takeEvents();
			const handled = [...unreadable];
			for (const event of events) {
				try {
					if (event.kind === "alarm") {
						const conversation = await runtime.runTrigger(event.trigger, event.live ? "live" : "later", event.device);
						log.info("trigger.run", { trigger: event.trigger, live: event.live, delayMs: Date.now() - event.at, conversation: conversation ?? "none" });
						await Triggers.started({ trigger: event.trigger });
						if (!event.live && conversation) handlers.onOpened(conversation);
						// The native side started the foreground service for it; release it if no run is going by then.
						setTimeout(releaseIfIdle, 30_000);
					} else {
						await handlers.onShare(event);
					}
				} catch (error) {
					log.warn("trigger.failed", { kind: event.kind, error: error instanceof Error ? error.message : String(error) });
				}
				handled.push(event.id);
			}
			if (handled.length > 0) await Triggers.ack({ ids: handled });
		});
		// A failed pass (the bridge rejecting events or ack) must not stop the later ones: the chain would stay
		// rejected and skip every pass after it until pi restarts. Unacknowledged events come again next pass.
		pass = pass.catch((error: unknown) => log.warn("trigger.drain_failed", { error: error instanceof Error ? error.message : String(error) }));
		return pass;
	};
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

/** pimobile://open?conversation=ID links, from notifications of triggered runs. */
export function listenForOpenLinks(onOpen: (conversation: string) => void): () => void {
	if (!nativeTriggers) return () => undefined;
	const handle = (link: string | undefined) => {
		if (!link?.startsWith("pimobile://open")) return;
		const conversation = new URL(link).searchParams.get("conversation");
		if (conversation) onOpen(conversation);
	};
	void App.getLaunchUrl().then((launch) => handle(launch?.url));
	const listener = App.addListener("appUrlOpen", ({ url }) => handle(url));
	return () => void listener.then((h) => h.remove());
}
