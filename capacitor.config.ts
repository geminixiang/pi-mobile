import type { CapacitorConfig } from "@capacitor/cli";

const isDevelopmentBuild = process.env.PI_MOBILE_DEBUG === "1";

const config: CapacitorConfig = {
	appId: "dev.geminixiang.pimobile",
	appName: "pi mobile",
	webDir: "dist",
	server: {
		androidScheme: "http",
	},
	android: {
		webContentsDebuggingEnabled: isDevelopmentBuild,
	},
};

export default config;
