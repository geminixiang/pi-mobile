import { AgentScreen } from "../plugins/agent-screen.ts";
import { isImplemented } from "../plugins/define.ts";

export const SCREENS = ["background", "front"] as const;
export type ScreenChoice = (typeof SCREENS)[number];

export type Screen = { on: "background"; display: number } | { on: "front"; instead?: string };

const NOT_SET_UP: Record<string, string> = {
	debugging_off: "wireless debugging is off (Developer options › Wireless debugging)",
	not_paired: "pi is not paired with wireless debugging yet",
};

export const backgroundSetup = {
	available: () => isImplemented(AgentScreen.pair),
	status: () => AgentScreen.status(),
	pair: (code: string) => AgentScreen.pair({ code }),
	pairInSettings: () => AgentScreen.pairInSettings(),
};

export type SetupStatus = Awaited<ReturnType<typeof backgroundSetup.status>>;

export async function screenFor(choice: ScreenChoice): Promise<Screen> {
	if (choice === "front") return { on: "front" };
	if (!isImplemented(AgentScreen.open)) return { on: "front", instead: "this phone has no background screen" };
	const opened = await AgentScreen.open();
	if (opened.ok) return { on: "background", display: opened.display };
	return { on: "front", instead: `the background screen is not available: ${NOT_SET_UP[opened.reason] ?? opened.reason}` };
}
