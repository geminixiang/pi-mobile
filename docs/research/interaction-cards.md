# 對話裡的互動卡：設計取捨

2026-11-04 先例調查的濃縮摘要（對照 Claude Agent SDK、ChatGPT / Apps SDK、OpenAI Agents SDK、Gemini、Grok Bot、Vercel AI SDK、assistant-ui、CopilotKit、LangGraph、AG-UI、MCP 2026-07-28、MCP Apps SEP-1865、Google A2UI，以及 Slack／Telegram／LINE／RCS／Apple Messages）。實作在 `src/interaction/`；A2UI 與 AG-UI 的另行評估見 [references.md](references.md)。

## 1. 兩種機制分開，不混用

- **下一則訊息（ask）**：`ask_user` 問題卡。卡片只負責顯示，點選即送出使用者訊息，不擋對話；天然支援直接打字回答，但須在工具回傳要求模型結束本輪（`End your turn now`）。選項維持 2–4 個、不加次要說明（依 `DESIGN.md`）；多選須另加送出鈕，等有第三個需求再做。
- **阻塞式閘門（gate）**：`Forms` 確認卡（MCP 表單／URL elicitation、動作確認）。工具暫停等待結果，回答成為工具呼叫的回傳值。結算聯集直接採 MCP `ElicitResult`：`accept(content)`、`decline`（明確說不）、`cancel`（關掉、打字略過或中斷）——`decline` 與 `cancel` 必須分開，伺服器會據此決定給替代方案或稍後再問。

## 2. 為什麼選原生卡片，不用其他協定／元件

- **MCP 2026-07-28 表單 elicitation（採用）**：MRTR 無狀態重送（`input_required` → 重送同一個 `tools/call` 帶 `inputResponses` 與不解析的 `requestState`），`requestedSchema` 刻意限為扁平基本型別＋單／多選 enum，讓客戶端用自己的元件畫；規格要求顯示伺服器名稱、送出前可檢視修改，密碼／token／付款須走 URL 模式（以系統瀏覽器開，如 Android Custom Tabs／iOS `SFSafariViewController`，不可用 App 內 WebView，規格禁止客戶端與 LLM 看到內容）。
- **MCP Apps（SEP-1865）／OpenAI Apps SDK（不做）**：伺服器送 HTML 進沙箱 iframe，帶來 CSP、UI 發起工具呼叫的二次核准、難審查與 WebView 效能成本；沒有任意 UI 需求前不走這條。
- **Google A2UI（只借 catalog 概念，不用協定／renderer）**：v0.9 仍為草稿，React renderer 與 `DESIGN.md` 衝突；pi 的「App 預先定義元件、模型只給資料」即同一方向。
- **AG-UI（不用）**：解的是跨網路邊界的事件與 interrupt 傳輸（有未決 interrupt 時新輸入不帶 `resume` 直接報 `RunError`）；pi 的 agent 與 UI 在同一個 WebView，不需要這層線協定。
- **Adaptive Cards／聊天平台外殼（不採）**：只取共同 UX 慣例——顯示文字與機器值分開、答案就地改寫原卡且不提供「撤回」（答案已入模型上下文，要改用下一則訊息說）、第一下即進 `submitting` 防連點（`Forms.answer` 原子取出，真正一次性仍靠伺服器保證）。

## 3. 阻塞卡的關鍵邊界與已知限制

- **打字代替點卡**：Vercel AI SDK 會丟 `AI_MissingToolResultsError`、AG-UI 丟 `RunError`；pi 採接近 Claude SDK `response` 的做法——直接打字時把等待中的卡結算為 `cancel`，再送出使用者文字，維持輸入框永遠可用。
- **重啟與逾時（2026-11-04 S24 實測更正）**：客戶端不設逾時。因為 codemode 腳本裡的呼叫 id 對不上畫面步驟，確認卡是讀 `Forms` 記憶體中待決項目並畫在對話末尾，不是從對話歷史推得。App 被殺掉時卡片消失、該次呼叫以中斷收尾（S24 實測模型會回報「無法確認是否已寄出」而不重寄，由使用者再說一次觸發伺服器重送 `input_required`）。重送若遇伺服器 `requestState` TTL 過期，錯誤顯示在卡片本身、不用 toast。
- **其他踩過的坑**：MRTR 一次 `inputRequests` 含多個 key 時畫在同一張卡一次送出（CopilotKit 曾修過多卡衝突）；重送只重跑該次 MCP 呼叫、不重跑模型或外部副作用；`destructiveHint` 僅為提示，不取代 App 自己的授權判斷；「永遠允許」是設定而非卡片狀態。
