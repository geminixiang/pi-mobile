import { registerPlugin } from "@capacitor/core";

type PhoneScreenStep = {
	action: "tap" | "long_press" | "swipe" | "scroll" | "type" | "clear" | "key" | "open" | "wait";
	x?: number;
	y?: number;
	to_x?: number;
	to_y?: number;
	direction?: "up" | "down" | "left" | "right";
	ms?: number;
	text?: string;
	keys?: string;
	app?: string;
};

export type PhoneScreenSnapshot = {
	width: number;
	height: number;
	package?: string;
	app?: string;
	keyboard: boolean;
	elements: string;
	more: number;
	jpeg?: string;
	shotError?: string;
	slow?: boolean;
	done?: number;
	error?: string;
};

interface PhoneScreenPlugin {
	status(): Promise<{ allowed: boolean }>;
	openSettings(): Promise<void>;
	openAppInfo(): Promise<void>;
	read(options: { screenshot: boolean }): Promise<PhoneScreenSnapshot>;
	act(options: { steps: PhoneScreenStep[]; screenshot: boolean }): Promise<PhoneScreenSnapshot>;
}

export const PhoneScreen = registerPlugin<PhoneScreenPlugin>("PhoneScreen");
