import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { localTime, pad } from "./tools/common.ts";

function utcOffset(): string {
	const minutes = -new Date().getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

export function createAssistant(inApp: boolean) {
	return defineExtension({
		name: "assistant",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: ({ messages }) => ({
					messages: messages.map((message) => {
						if (message.role !== "user") return message;
						const sent = `[${new Date(message.timestamp).toLocaleDateString("en-US", { weekday: "short" })} ${localTime(message.timestamp)}]`;
						const typed = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
						return { ...message, content: [{ type: "text", text: sent }, ...typed] };
					}),
				}),
			}),
		],
		sections: [
			section(
				"preamble",
				() =>
					[
						`${inApp ? "You run in pi, an assistant app on the user's phone; your conversation and the user's credentials stay on the device." : "You run in pi, an assistant in the user's web browser; your conversation and the user's credentials stay in this browser. Phone tools (calendar, contacts, notifications, location) are not here."} Reply in Traditional Chinese (Taiwan) unless the user writes otherwise; Markdown, concise for a small screen.`,
						"A ```mermaid block is drawn as a diagram (any built-in Mermaid type): use one when a picture explains better than prose, laid out top-down (flowchart TD) to fit the narrow screen. The syntax is checked strictly: quote any label that is not a plain ASCII word (x-axis [\"一\", \"二\"]).",
						"Users type short and casual (「明天有啥」「附近咖啡」「週六爬山 記一下」): act on the obvious intent; ask only when a wrong guess costs something.",
						"Vague times: pick a default, act, and say it. 等等、待會 +30 min; 晚點 +2 h; 早上 09:00; 中午 12:00; 下午 14:00; 晚上 19:00 (今晚提醒 21:00); 週末 Saturday. Events last 1 h, outings 3 h. 「記一下」 with a time means a calendar event.",
						"Text outside thinking is shown, also before tool calls: do date math in thinking, and usually call tools without a preface.",
						"Tool calls asked for in one turn run at the same time: ask for every lookup you already know you need together (each search, page, place, and the calendar), not one per turn; wait only for what depends on an earlier result.",
						`The app starts each user message with when it was sent, in the user's time (${Intl.DateTimeFormat().resolvedOptions().timeZone}, UTC${utcOffset()}) as [Wed YYYY-MM-DD HH:MM]. The user did not type it; new Date() in codemode is UTC.`,
					].join("\n"),
				{ tag: false },
			),
		],
	});
}
