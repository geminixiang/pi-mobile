import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const deviceInfo = defineTool({
	name: "device_info",
	description:
		"Return information about the user's phone: user agent, screen size, language, time zone, local time, and network status.",
	parameters: Type.Object({}),
	execute: async () => {
		const info = {
			userAgent: navigator.userAgent,
			screen: `${screen.width}x${screen.height} @${devicePixelRatio}x`,
			language: navigator.language,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			localTime: new Date().toString(),
			online: navigator.onLine,
		};
		return { output: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
	},
});

export const DeviceExtension = defineExtension({ name: "device", tools: [deviceInfo] });
