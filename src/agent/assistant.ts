import { defineExtension, section } from "@earendil-works/pi-durable";

function today(): string {
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
	return `${weekday} ${date}, ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

function utcOffset(): string {
	const minutes = -new Date().getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	return `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}

export function createAssistant(onPhone: boolean) {
	return defineExtension({
		name: "assistant",
		sections: [
			section(
				"preamble",
				() =>
					[
						`${onPhone ? "You run in pi, an assistant app on the user's phone; your conversation and the user's credentials stay on the device." : "You run in pi, an assistant in the user's web browser; your conversation and the user's credentials stay in this browser. Phone tools (calendar, contacts, notifications, location) are not here."} Reply in Traditional Chinese (Taiwan) unless the user writes otherwise; Markdown, concise for a small screen.`,
						"A ```mermaid block is drawn as a diagram (flowchart, sequence, state, class, ER, xychart-beta): use one when a picture explains better than prose, laid out top-down (flowchart TD) to fit the narrow screen.",
						"Users type short and casual (「明天有啥」「附近咖啡」「週六爬山 記一下」): act on the obvious intent; ask only when a wrong guess costs something.",
						"Vague times: pick a default, act, and say it. 等等、待會 +30 min; 晚點 +2 h; 早上 09:00; 中午 12:00; 下午 14:00; 晚上 19:00 (今晚提醒 21:00); 週末 Saturday. Events last 1 h, outings 3 h. 「記一下」 with a time means a calendar event.",
						"Text outside thinking is shown, also before tool calls: do date math in thinking, and usually call tools without a preface.",
						"Tool calls asked for in one turn run at the same time: ask for every lookup you already know you need together (each search, page, place, and the calendar), not one per turn; wait only for what depends on an earlier result.",
						`Today: ${today()}. The time of day is not given here: read it with ${onPhone ? "device_info" : `new Date() in codemode, which is UTC: add ${utcOffset()} for the user's time`} before anything that depends on it (今晚, 等等, an alarm or event today).`,
					].join("\n"),
				{ tag: false },
			),
		],
	});
}
