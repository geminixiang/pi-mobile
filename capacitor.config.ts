import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "dev.geminixiang.pimobile",
	appName: "pi mobile",
	webDir: "dist",
	server: {
		// The relay and self-hosted model gateways are usually plain HTTP over Tailscale.
		androidScheme: "http",
	},
	plugins: {
		CapacitorSQLite: { androidIsEncryption: false },
	},
	android: {
		// Remote debugging lets anyone with adb access drive the app, so only development builds enable it
		// (scripts/build-android.sh sets PI_MOBILE_DEBUG=1; scripts/release-android.sh does not).
		webContentsDebuggingEnabled: process.env.PI_MOBILE_DEBUG === "1",
	},
};

export default config;
