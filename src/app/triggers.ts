import { App } from "@capacitor/app";
import type { AgentRuntime, ConversationId } from "../agent/runtime.ts";
import { nativeTriggers, type QueuedEvent, takeEvents, Triggers } from "../agent/triggers.ts";
import { log } from "../log.ts";
import { releaseIfIdle } from "./keepAlive.ts";
import { messageOf } from "../promise.ts";

const RETRY_FOR_MS = 24 * 60 * 60 * 1000;

export type SharedItem = Extract<QueuedEvent, { kind: "share" }>;

export function processTriggerEvents(
	runtime: AgentRuntime,
	handlers: {
		onShare: (item: SharedItem) => Promise<void>;
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
						const conversation = await runtime.triggers.run(event.trigger, event.live ? "live" : "later", { event: event.id, ...(event.device ? { device: event.device } : {}) });
						log.info("trigger.run", { trigger: event.trigger, live: event.live, delayMs: Date.now() - event.at, conversation: conversation ?? "none" });
						await Triggers.started({ trigger: event.trigger });
						if (!event.live && conversation) handlers.onOpened(conversation);
						setTimeout(releaseIfIdle, 30_000);
					} else {
						await handlers.onShare(event);
					}
					handled.push(event.id);
				} catch (error) {
					const expired = Date.now() - event.at > RETRY_FOR_MS;
					log.warn(expired ? "trigger.dropped" : "trigger.retry_later", { kind: event.kind, error: messageOf(error) });
					if (expired) handled.push(event.id);
				}
			}
			if (handled.length > 0) await Triggers.ack({ ids: handled });
		});
		pass = pass.catch((error: unknown) => log.warn("trigger.drain_failed", { error: messageOf(error) }));
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
