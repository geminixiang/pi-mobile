import { useSyncExternalStore } from "react";

export type Layout = "phone" | "columns" | "stacked";

export const WIDE_MIN_WIDTH = 600;
export const COLUMNS_MIN_WIDTH = 840;
export const WIDE_MIN_HEIGHT = 480;

export function layoutAt(width: number, height: number): Layout {
	if (width < WIDE_MIN_WIDTH || height < WIDE_MIN_HEIGHT) return "phone";
	return width >= COLUMNS_MIN_WIDTH ? "columns" : "stacked";
}

const PHONE_ONLY = ["drawer", "panel", "workspace"] as const;

export function shownOverlay<O extends string>(overlay: O | undefined, layout: Layout): O | undefined {
	if (layout === "phone" || overlay === undefined) return overlay;
	return PHONE_ONLY.some((only) => only === overlay) ? undefined : overlay;
}

const subscribe = (changed: () => void) => {
	window.addEventListener("resize", changed);
	return () => window.removeEventListener("resize", changed);
};

export function useLayout(): Layout {
	return useSyncExternalStore(subscribe, () => layoutAt(window.innerWidth, window.innerHeight));
}
