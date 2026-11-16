import { useSyncExternalStore } from "react";
import type { Source } from "../ui/subscribed.ts";

type Layout = "phone" | "columns" | "stacked";

export const WIDE_MIN_WIDTH = 600;
const COLUMNS_MIN_WIDTH = 840;
export const WIDE_MIN_HEIGHT = 480;

export function layoutAt(width: number, height: number): Layout {
	if (width < WIDE_MIN_WIDTH || height < WIDE_MIN_HEIGHT) return "phone";
	return width >= COLUMNS_MIN_WIDTH ? "columns" : "stacked";
}

const PHONE_ONLY = ["drawer", "workspace"] as const;

export function shownOverlay<O extends string>(overlay: O | undefined, layout: Layout): O | undefined {
	if (layout === "phone" || overlay === undefined) return overlay;
	return PHONE_ONLY.some((only) => only === overlay) ? undefined : overlay;
}

export const layout: Source<Layout> = {
	subscribe: (changed) => {
		window.addEventListener("resize", changed);
		return () => window.removeEventListener("resize", changed);
	},
	read: () => layoutAt(window.innerWidth, window.innerHeight),
};

export function useLayout(): Layout {
	return useSyncExternalStore(layout.subscribe, layout.read);
}
