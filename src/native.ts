import { Capacitor } from "@capacitor/core";
import { hasPlugin, isImplemented, type PluginMethod } from "./plugins/define.ts";
import { PLUGINS } from "./plugins/index.ts";

export type NativePlugin = (typeof PLUGINS)[number]["name"];

export const NATIVE_PLUGINS: readonly NativePlugin[] = PLUGINS.map((plugin) => plugin.name);

export interface Native {
	has(plugin: NativePlugin): boolean;
	implements(method: PluginMethod): boolean;
}

export const inApp = Capacitor.isNativePlatform();

export const ios = Capacitor.getPlatform() === "ios";

export const native: Native = { has: hasPlugin, implements: isImplemented };
