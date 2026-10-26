import { registerPlugin } from "@capacitor/core";

export const STREAMS = ["ring", "media", "alarm", "notification", "call"] as const;
type Stream = (typeof STREAMS)[number];
export type Ringer = "normal" | "vibrate" | "silent";
export type SoundState = { ringer: Ringer; volumePercent: Record<Stream, number> };

export type DisplayState = {
	canChange: boolean;
	brightnessPercent?: number;
	autoBrightness?: boolean;
	autoRotate?: boolean;
	screenTimeoutSeconds?: number;
};
const DISPLAY_SETTINGS = ["brightness", "auto_brightness", "auto_rotate", "screen_timeout"] as const;
type DisplaySetting = (typeof DISPLAY_SETTINGS)[number];

export const CONNECTIONS = ["wifi", "bluetooth", "mobile_data", "airplane_mode", "location", "nfc", "battery_saver"] as const;
export type Connection = (typeof CONNECTIONS)[number];
export type ConnectionsState = {
	wifi: { on: boolean; connected: boolean; name?: string };
	bluetooth: { on: boolean; connectedProfiles?: string };
	mobileData: { on?: boolean | "unknown" };
	airplaneMode: boolean;
	location: boolean;
	nfc: "on" | "off" | "none";
	batterySaver: boolean;
	outcome?: "already" | "changed" | "pressed" | "panel";
};

interface PhoneStatePlugin {
	sound(): Promise<SoundState>;
	setRinger(options: { mode: Ringer }): Promise<SoundState>;
	setVolume(options: { stream: Stream; percent: number }): Promise<SoundState>;
	display(): Promise<DisplayState>;
	setDisplay(options: { what: DisplaySetting; value?: number; on?: boolean }): Promise<DisplayState>;
	openWriteSettings(): Promise<void>;
	flashlight(): Promise<{ state: "on" | "off" | "unavailable" }>;
	setFlashlight(options: { on: boolean }): Promise<{ state: "on" | "off" | "unavailable" }>;
	connections(): Promise<ConnectionsState>;
	setConnection(options: { what: Connection; on: boolean }): Promise<ConnectionsState>;
}

export const PhoneState = registerPlugin<PhoneStatePlugin>("PhoneState");
