# 要不要加 skill loader（2026-11-15）

使用者問：pi mobile 要不要加 skill loader？加了就得決定 skill 和腳本放哪；手機的 just-bash 很薄，可能發揮不出 skill 的強項。

來源：gpt-6-astra 調查 skill 生態（Anthropic Agent Skills、pi、Codex、Cursor、Gemini CLI、Goose、SkillsBench 論文，連結在它的報告裡）；claude-fable-5-2 讀 pi mobile 的程式盤點手機和電腦能跑什麼（`file:line`）；我對過關鍵幾處。

## 現況

- 內建 5 份 skill，都是純文字（`src/agent/skills.ts`）；系統提示只列名稱和時機（573 字元），`read_skill` 用到才讀全文。
- **手機能跑什麼**：just-bash 約 80 個指令加 `git`、`gh`，沒有 python、node、curl、sqlite3；codemode 是 QuickJS（128 MiB、沒有 `fetch` 和模組，但能呼叫 `tools.*`）。寫成呼叫 `tools.*` 的 JS 可以跑，Python 和 Node 腳本不行。
- **電腦能跑什麼**：直接模式用使用者自己的環境；容器有 Node 26、Python 3.13、uv、sqlite3、pandoc 等。
- **skill 的價值三者都有**：說明（做法、判斷）、資源（範本、規格）、腳本（確定性的轉換和驗證）。SkillsBench 的平均通過率從 33.9% 提高到 50.5%，但沒分清是哪一塊的功勞。Anthropic 官方最常裝的 skill 裡，`pdf`、`docx`、`xlsx`、`pptx`、`webapp-testing` 沒有 Python、Node 就整個壞掉；寫作、溝通、設計規範類的照樣能用。

## 決定

1. **先做：每個 Bot 自己寫的純文字 skill（程序性記憶）**。使用者說「以後都這樣做」或 Bot 重複一套做法時，`save_skill(name, when, text)` 存進每個 Bot 的 doc（比照 `BotMemoryDoc`），系統提示每份一行，用到才 `read_skill`。這也解掉一個現有成本：寫在 MEMORY.md 的做法每次請求都整份重送。上限建議每個 Bot 8 份、`when` 120 字元、內容 4000 字元，加之前照 `docs/tools.md` 量工具成本。使用者在 Bot 面板看得到、改得了。
2. **其次：電腦上的 Bot 讀電腦自己的 skill**。直接模式的提示加一句：去 `~/.agents/skills`、`~/.claude/skills` 找對應的 `SKILL.md`，腳本在電腦上用真的 Python、Node 跑。真正的重活本來就能 `tell_agent` 交給電腦上的 agent，它們有自己的 skill 系統。
3. **延後**：從 git 同步第三方 skill 包到手機、附腳本、全域共用的 skill。
4. **永遠不做**：從網址、網頁、通知或 MCP 結果安裝 skill；載入時執行腳本；在手機上帶著憑證跑 skill 的腳本；把 skill 全文放進系統提示；讓 skill 加工具或改 `Bot.off`；讓 Bot 改內建或別的 Bot 的 skill。
5. **待使用者決定**：排程觸發、使用者不在場時，禁止 `save_skill`（避免一則通知的內容變成長期指令）。

第一份要加的內建 skill 是「資料表設計」，見 [database-design.md](database-design.md)。
