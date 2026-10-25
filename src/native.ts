import { Capacitor } from "@capacitor/core";

export const NATIVE_PLUGINS = [
	"Apps",
	"BotFiles",
	"Calendar",
	"Contacts",
	"Database",
	"Health",
	"KeepAlive",
	"Loopback",
	"Notifications",
	"Page",
	"Phone",
	"PhoneScreen",
	"Photos",
	"Records",
	"Scanner",
	"StreamFetch",
	"System",
	"Triggers",
	"Usage",
	"Voice",
] as const;

export type NativePlugin = (typeof NATIVE_PLUGINS)[number];

export const inApp = Capacitor.isNativePlatform();

export const ios = Capacitor.getPlatform() === "ios";

export const native: ReadonlySet<NativePlugin> = new Set(NATIVE_PLUGINS.filter((name) => Capacitor.isPluginAvailable(name)));
