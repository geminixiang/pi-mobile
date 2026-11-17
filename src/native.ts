import { Capacitor } from "@capacitor/core";
import { hasPlugin, isImplemented, NATIVE_PLUGINS, type NativePlugin, type PluginMethod } from "./plugins/define.ts";

export { NATIVE_PLUGINS, type NativePlugin };

export interface Native {
	has(plugin: NativePlugin): boolean;
	implements(method: PluginMethod): boolean;
}

export const inApp = Capacitor.isNativePlatform();

export const ios = Capacitor.getPlatform() === "ios";

export const native: Native = { has: hasPlugin, implements: isImplemented };
