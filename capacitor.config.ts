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
	experimental: {
		// why: the iOS app targets iOS 26, and Swift tools before 6.2 have no .v26 for the Package.swift Capacitor writes
		ios: { spm: { swiftToolsVersion: "6.2" } },
	},
};

export default config;
