import { ArrowIcon } from "pi-mobile-ui/elements";
import { pad } from "pi-mobile-base/time";

interface Suggestion {
	title: string;
	prompt: string;
}

export type SharedKind = "image" | "file" | "text" | "screen";

export function SuggestionList({ items, onPick }: { items: readonly Suggestion[]; onPick: (item: Suggestion) => void }) {
	return (
		<ol className="suggestions">
			{items.map((item, index) => (
				<li key={item.title}>
					<button type="button" onClick={() => onPick(item)}>
						<span className="suggestion-index">{pad(index + 1)}</span>
						<span className="suggestion-text">
							<strong>{item.title}</strong>
							<span>{item.prompt}</span>
						</span>
						<ArrowIcon />
					</button>
				</li>
			))}
		</ol>
	);
}

export function shareActions(kind: SharedKind): Suggestion[] {
	if (kind === "screen") {
		return [
			{ title: "這頁在講什麼", prompt: "這個畫面在講什麼？用幾句話說重點" },
			{ title: "幫我回覆", prompt: "幫我想一個回覆，簡短、口語" },
			{ title: "接下來要做什麼", prompt: "看這個畫面，我接下來要做什麼？有日期或待辦就幫我排進行事曆" },
		];
	}
	if (kind === "file") {
		return [
			{ title: "摘要", prompt: "讀一下這份檔案，用幾點摘要重點" },
			{ title: "找出要注意的", prompt: "這份檔案裡有哪些日期、金額或要我做的事？" },
			{ title: "翻譯", prompt: "翻成繁體中文" },
		];
	}
	return kind === "image"
		? [
				{ title: "這是什麼", prompt: "這張圖裡有什麼？" },
				{ title: "抄下文字", prompt: "把圖裡的文字抄下來，不是中文的話翻成中文" },
				{ title: "排進行事曆", prompt: "如果這是活動或行程，幫我加到行事曆" },
			]
		: [
				{ title: "摘要", prompt: "讀一下這個，用幾點摘要重點" },
				{ title: "翻譯", prompt: "翻成繁體中文" },
				{ title: "晚點提醒我", prompt: "今晚 9 點提醒我看這個，附上一句摘要" },
			];
}
