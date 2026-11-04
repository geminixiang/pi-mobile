# 對話裡的互動卡：先例調查

調查日期：2026-11-04。目的：替 pi mobile 的 `interaction` 擴充（已有 `ask_user`，下一步是 MCP 2026-07-28 表單 elicitation 的確認卡）找先例。

證據標記：
- **〔文件〕**：讀過官方文件或規格頁（附連結）。
- **〔二手〕**：只有第三方文章、論壇或社群整理，沒有官方原文。
- **〔推論〕**：我依據文件推出來的，沒有寫明。
- **〔讀碼〕**：讀過 pi mobile 的程式，註明檔案。

---

## 0. 結論先講

1. 業界其實只有兩種機制，混在一起就會出錯：
   - **A. 阻塞式（gate）**：工具執行停住，等使用者回答，回答成為**這次工具呼叫的結果**。Claude Agent SDK 的 `canUseTool`/`AskUserQuestion`、Vercel AI SDK、assistant-ui、CopilotKit、LangGraph `interrupt()`、OpenAI Agents SDK、AG-UI interrupt、MCP elicitation/MRTR 都是這種。
   - **B. 下一則訊息（ask）**：卡片只是顯示，點選等於使用者送出一則訊息，對話不被擋住。Telegram/LINE/RCS 的 quick reply、FastMCP 的 `Choice`、pi mobile 現在的 `ask_user` 是這種。
2. 阻塞式的共同難題是「使用者不點卡、直接打字」：Vercel 會丟 `AI_MissingToolResultsError`，AG-UI 會 `RunError`，Claude SDK 用一個 `response` 欄位把打字當成答案。**pi mobile 的確認卡必須先決定這件事。**
3. 誰畫 UI：大多數是「應用程式自己定義元件、模型或伺服器只給資料」（Claude、Vercel、assistant-ui、CopilotKit、MCP 表單 elicitation、Google A2UI 的 catalog）。伺服器直接送 HTML（MCP Apps、OpenAI Apps SDK）只在需要任意 UI 時才值得；pi mobile 不該先走這條。
4. 回答後的樣子幾乎都一樣：**原卡片就地改寫成結果**（Slack `replace_original`、Telegram 編輯鍵盤、Apple 的 ReplyMessage 泡泡、FastMCP「Response sent.」、Grok Bot「已傳送 · 收件人」），選項消失或停用，沒有人做「撤回答案」。
5. 狀態的最大公約數是 MCP 的 `accept | decline | cancel`，加上一個「過期」。AG-UI 也是 `resolved | cancelled` + `expiresAt`。

---

## 1. 產品

### 1.1 Claude Code `AskUserQuestion` 與 Agent SDK〔文件〕

來源：[Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)

- **形狀**：`{ questions: [{ question, header, options: [{ label, description, preview? }], multiSelect }] }`。一次 1–4 題，每題 2–4 個選項；`header` 是最多 12 字元的短標籤（chip）。
- **回答流向**：阻塞式。工具呼叫觸發 `canUseTool(toolName, input, { signal })`，應用程式顯示卡片，回傳 `{ behavior: "allow", updatedInput: { questions, answers } }`。`answers` 以**題目文字為 key、選項 label 為 value**；多選傳陣列或用 `", "` 串起來。
- **自由輸入**：應用程式應在選項後加一個「Other」，**把使用者打的字當答案，而不是送 "Other" 這個字**。另有 `response` 欄位：使用者關掉卡片、改打一段不針對任何題目的話時用，Claude 收到的是「The user responded: …」而不是逐題答案。這是「打字代替點卡」最乾淨的官方作法。
- **預覽**：`toolConfig.askUserQuestion.previewFormat` 設 `"markdown"` 或 `"html"` 時，選項可帶 `preview`（HTML 片段不准 `<script>`/`<style>`），只用在單選。
- **逾時**：回呼「可以無限期等」。要讓行程先結束，用 `PreToolUse` hook 回傳 `defer`，之後從持久化的 session 恢復。
- **模型側提示**〔二手，來自外流的工具提示詞 [tangled.org dump](https://tangled.org/oppi.li/claude-code/blob/main/tools/AskUserQuestionTool/prompt.ts)〕：「使用者永遠可以選 Other 自己打」；推薦選項放第一個並在 label 後加「(Recommended)」；plan mode 不要用它問「計畫可以了嗎」。
- **工具核准**（同一頁）：`allow`（可帶修改過的 `updatedInput`）、`deny`（帶 `message`，Claude 會看到並改做法）、「核准並記住」（回傳 `updatedPermissions`）。也就是三種：一次、永遠、拒絕。

### 1.2 Claude.ai / Claude App〔二手〕

- 社群貼文指出 claude.ai 有一個 `ask_user_input_v0` 工具，畫出可點的選項、多選、排序；手機上直接點選。來源：[Reddit 快照](https://reddit.sentinel-team.org/posts/1rrevkd/snapshots/2026-03-14T00%3A11%3A38.395735Z)、[youmind 文章](https://youmind.com/landing/x-viral-articles/claude-ask-user-input-prompt-hack)。沒有官方文件，渲染細節未證實。

### 1.3 ChatGPT

- **Agent mode 確認**〔二手〕：發布時 OpenAI 表示 agent「在重要步驟前（例如寄信或傳訊息給商家）會要求確認」，購買前暫停；**Takeover mode** 讓使用者自己在瀏覽器輸入登入和卡號，不經過 agent。來源：[CX Today](https://www.cxtoday.com/conversational-ai/openais-new-chatgpt-agent-will-find-communicate-with-and-buy-from-businesses/)。
- **Apps SDK**〔文件〕：[Apps SDK reference](https://developers.openai.com/apps-sdk/reference)
  - 工具註記 `readOnlyHint`、`destructiveHint`（「讓 host 先要求明確核准」）、`openWorldHint`、`idempotentHint`。**只影響 ChatGPT 怎麼向使用者描述這次呼叫，伺服器仍要自己做授權。** 需要核准的工具，元件一開始拿不到 `toolInput`，使用者核准後 host 才送 `ui/notifications/tool-input`。
  - 元件 API：`window.openai.toolInput / toolOutput / widgetState / setWidgetState / callTool / sendFollowUpMessage({ prompt }) / requestDisplayMode`。`setWidgetState` 每次有意義的互動後都要呼叫，讓重新渲染（例如回看歷史）時還原狀態。
  - `_meta["openai/toolInvocation/invoking" | "invoked"]`：工具執行中與完成後的短狀態字（≤64 字元）——這就是 ChatGPT 的「進度卡」。
  - OpenAI 建議新 UI 走 MCP Apps 橋接，`window.openai` 只用於 ChatGPT 專屬功能。
- **對話中的選項按鈕**：OpenAI 社群多年來一直有人要求「可點的選項」([1](https://community.openai.com/t/feature-request-contextual-reply-buttons-for-discrete-choices-in-chatgpt/1376284), [2](https://community.openai.com/t/clickable-option-boxes-in-chat/1373248))，表示一般對話長期沒有這個功能〔二手〕。2026-10 有報導說 ChatGPT 推出「Intelligent UI」，回覆裡可以有按鈕、表單〔二手，未找到 OpenAI 原文，例如 [techenclave](https://techenclave.com/news/items/chatgpt-adds-interactive-answers-as-gpt-6-reaches-free-and-go-users)〕。
- **OpenAI Agents SDK 工具核准**〔文件〕：[Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
  - `needsApproval: true | async (ctx, args) => boolean`。需要核准時工具不執行，回合結束，待處理項目在 `result.interruptions`（`RunToolApprovalItem`）。
  - `result.state.approve(item)` / `reject(item, { message })`；`alwaysApprove / alwaysReject` 設定這次 run 剩下的預設。不必一次處理完，沒處理的會再次暫停。
  - `result.state.toString()` 序列化、`RunState.fromString()` 恢復，用於長時間等待。
  - 安全：手機或瀏覽器核准時，快照留在伺服器，驗證每個決定對應到儲存的請求，**原子地消耗每個待處理請求以防重放**（例如連點兩次「傳送」）。

### 1.4 Gemini〔文件〕

來源：[Use Gemini Agent for multi-step tasks](https://support.google.com/gemini/answer/16596215)

- 敏感動作前暫停等核准：**傳送訊息、修改或刪除資料、購買、填寫並送出網頁表單**、用 Google 帳號登入網站、分享健康/財務/證件等敏感資料。
- 輸入密碼或付款資料時要使用者「接管」瀏覽器（Take over task → Go back to Gemini）。
- 進度：一個進度 chip 打開工作面板，步驟分成已完成、目前、計畫中，另列讀過或改過的檔案。

### 1.5 Grok Bot〔文件＋本地觀察〕

- 官方文件 [Security › Approvals and Auto Review](https://docs.x.ai/grok-bot/security)：需要核准時「對話裡顯示提議的操作和它的輸入」，選項是 **Allow once / Always allow / Deny**；「**Deny 會停止這個動作，Bot 在使用者送出下一則訊息前不會再試**」。另有獨立的審查模型（Auto Review）決定放行、要核准或拒絕。密碼和一次性密碼「不屬於一般對話」。
- 實際畫面（`docs/research/grok-bot.md`，在 S24 上觀察）：問題卡 A–D 加「或在下方聊天中回答」；可展開的郵件卡，按「傳送」才寄，之後卡片顯示「已傳送 · 收件人」；對話中的 Gmail 連接卡；做完事後問「要我每天早上幫你看信箱嗎？」，點「好」後一行「Created routine」。
- Grok Bot 問題卡是阻塞還是下一則訊息，文件沒寫〔推論：提示「或在下方聊天中回答」表示打字也算回答，行為像 B〕。

---

## 2. 框架

### 2.1 Vercel AI SDK〔文件〕

來源：[Chatbot Tool Usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)、[Missing Tool Results Error](https://ai-sdk.dev/docs/troubleshooting/missing-tool-results-error)

- 工具呼叫是訊息裡的一個 part，有明確狀態：`input-streaming → input-available → (approval-requested → approval-responded) → output-available | output-error | output-denied`。**文件要求即使工具不用核准，UI 也要處理 approval 和 denied 狀態。**
- 客戶端工具（沒有 server `execute`）：UI 依 part 畫卡片，使用者回答後 `addToolOutput({ tool, toolCallId, output })`。
- 核准：在 `streamText` 設 `toolApproval: { tool: 'user-approval' }`（`needsApproval` 已廢棄），UI 呼叫 `addToolApprovalResponse({ id: part.approval.id, approved })`。
- 回答後續跑：`sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`（或 `...WithApprovalResponses`）。
- **打字代替點卡**：有未完成的工具呼叫時送新訊息，SDK 驗證歷史會丟 `AI_MissingToolResultsError`。解法是在新使用者訊息前補一個 tool result（或核准回應）。也就是框架不替你決定，應用程式必須先把待處理的卡結算掉。

### 2.2 assistant-ui〔文件，部分二手〕

- `makeAssistantToolUI({ toolName, render })`，`render` 拿到 `args`、`result`、`status`、`addResult`；`status.type` 有 `running | complete | incomplete | requires_action`。人在迴路的工具在 `requires_action` 時顯示按鈕，按下呼叫 `addResult(...)`。來源：[make-assistant-tool-ui](https://www.assistant-ui.com/docs/copilots/make-assistant-tool-ui)。第三方頁面寫成 `"requires-action"` 和 `submitResult`，版本不同〔二手〕。

### 2.3 CopilotKit〔文件＋二手〕

- 新 API `useHumanInTheLoop({ name, description, parameters, render })`，`render` 拿到 `args`、`status`、`respond`；`respond(result)` 的值成為工具結果，agent 接著跑。另有 `useInterrupt` 接 LangGraph 的 `interrupt()`。來源：[Human in the loop](https://docs.copilotkit.ai/human-in-the-loop)。
- 舊 API `useCopilotAction({ renderAndWaitForResponse })`，`status` 為 `inProgress`（參數還在串流、可能不完整）/`executing`/`complete`〔文件：[useCopilotAction](https://docs.copilotkit.ai/reference/hooks/useCopilotAction)〕。
- 坑：v1.9.2 修了「畫面上有多張 HITL 卡時無法連續處理」〔二手〕。

### 2.4 LangGraph `interrupt()` 與 HumanInTheLoopMiddleware〔文件〕

來源：[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)、[Human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)

- `interrupt(value)` 暫停並由 checkpointer 存狀態；結果在 `__interrupt__`；以 `Command(resume=value)` 恢復，值成為 `interrupt()` 的回傳值。可選 `response_schema`。
- **坑：恢復時整個 node 從頭重跑**，`interrupt()` 之前的副作用會再做一次，必須冪等或移到後面。不能用裸 `try/except` 包住（會吃掉暫停例外）；多個 interrupt 依順序對應，不可條件式跳過。
- Middleware：每個工具設定 `allowed_decisions`，決定有四種：`approve`、`edit`（改參數再執行）、`reject`、`respond`（使用者自己扮演工具，例如回答 ask_user）。決定的順序必須和請求一致。

### 2.5 AG-UI 協定〔文件〕

來源：[Interrupts](https://docs.ag-ui.com/concepts/interrupts.md)

```ts
type Interrupt = { id; reason /* "tool_call" | "input_required" | "confirmation" */; message?; toolCallId?;
  responseSchema?; expiresAt?; metadata? }
RUN_FINISHED.outcome = { type: "success" } | { type: "interrupt"; interrupts: Interrupt[] }
RunAgentInput.resume = [{ interruptId, status: "resolved" | "cancelled", payload? }]
```

- 規則：一個 `resume` 必須涵蓋所有未決 interrupt；**thread 有未決 interrupt 時，任何新輸入都必須帶 `resume`，否則 `RunError`**；過了 `expiresAt` 不能再回；拒絕放在 payload（`approved: false`），`cancelled` 代表「沒有有意義的回答」；resume 是冪等的。
- 伺服器執行的工具：客戶端只送核准，不得自己合成工具結果。

---

## 3. 協定

### 3.1 MCP elicitation：2025-06-18 → 2025-11-25 → 2026-07-28〔文件〕

來源：[Elicitation (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)、[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)、[2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)、[2026-07-28 公告](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

演進：
- 2025-06-18：伺服器發出 `elicitation/create` 請求（需要開著的串流），表單模式。
- 2025-11-25：加 **URL 模式**（SEP-1036）、有標題/無標題、單選/多選 enum（SEP-1330）、所有基本型別的 `default`（SEP-1034）。
- 2026-07-28：**MRTR 取代伺服器主動請求**（破壞性變更）。伺服器回 `{ resultType: "input_required", inputRequests: { key: { method: "elicitation/create", params } }, requestState? }`；客戶端蒐集答案後**以新的 JSON-RPC id 重送原本的 `tools/call`**，帶 `inputResponses: { key: ElicitResult }` 並原樣回傳 `requestState`（不准解析）。核心改成無狀態，不再有 `initialize` 和 session id。

表單模式重點：
- `requestedSchema` 只能是**扁平物件 + 基本型別**：string（`format`: email/uri/date/date-time，min/maxLength）、number/integer（min/max）、boolean、enum（`enum` 或 `oneOf: [{ const, title }]`）、多選（`type: "array"`，`items.enum` 或 `items.anyOf`，min/maxItems）。不支援巢狀和物件陣列，這是刻意的，為了讓客戶端好畫。客戶端支援 default 時 SHOULD 預填。
- 回應：`{ action: "accept", content }` | `{ action: "decline" }`（明確拒絕）| `{ action: "cancel" }`（關掉、沒做選擇）。
- **客戶端 MUST**：清楚顯示是哪個伺服器在要資料；提供拒絕與取消；**表單模式讓使用者送出前能檢視和修改**；URL 模式顯示目標網域並取得同意後才開。
- 伺服器 MUST NOT 用表單要密碼、API key、token、付款資料，這些必須走 URL 模式。表單欄位裡不該放可點的網址。

URL 模式重點：
- `{ mode: "url", url, message }`；`accept` 只代表「同意開啟」，不代表完成，客戶端重送時伺服器依 `requestState` 判斷是否完成，未完成就再回一次 `input_required`。客戶端 SHOULD 提供手動「重試/取消」。
- 客戶端 MUST NOT 預先抓取網址、MUST 顯示完整網址、**MUST 用客戶端和 LLM 都看不到內容的方式開啟**（iOS 舉例 SFSafariViewController 可以、WKWebView 不行）；SHOULD 強調網域、警告 Punycode。〔推論：Android 對應的是 Custom Tabs，不是 app 內 WebView。〕

MRTR 的狀態與逾時：
- 伺服器 SHOULD 在受完整性保護的 `requestState` 裡放主體、**短 TTL**、原始請求摘要，防重放；但這不保證只用一次，一次性的動作要伺服器自己保證。
- 伺服器「MUST NOT 假設客戶端會完成或重送」——**放棄回答在協定上是合法的**，客戶端什麼都不送也可以。
- 客戶端只送一部分答案時，伺服器 SHOULD 再回 `input_required` 而不是錯誤。
- 規格對客戶端該等多久、UI 長什麼樣都沒規定（公告也沒有）。

### 3.2 MCP Apps（SEP-1865）與 MCP-UI〔文件〕

來源：[SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)、[ext-apps 規格草稿](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)

- 工具用 `_meta.ui.resourceUri` 指向預先宣告的 `ui://` 資源（`text/html;profile=mcp-app`），host 在沙箱 iframe 裡畫。由 OpenAI、Anthropic 和 MCP-UI 作者共同提出，合併了 MCP-UI 與 Apps SDK。
- View → Host：`ui/initialize`、`ui/message`（送內容到對話）、`ui/open-link`、`ui/update-model-context`、`ui/request-display-mode`、`tools/call`（代理到伺服器）、`sampling/createMessage`（需 host 核准）。Host → View：`ui/notifications/tool-input` 等。
- `_meta.ui.visibility`：`["model","app"]`，只給 `app` 的工具模型看不到。CSP 預設全封（`default-src 'none'`），網域要宣告。
- 安全：沙箱、預先宣告的模板可審查、所有訊息可記錄、**host 可要求 UI 發起的工具呼叫需使用者核准**。
- 例子：FastMCP 的 [`Choice` provider](https://gofastmcp.com/apps/providers/choice)〔文件〕——模型呼叫 `choose(prompt, options)`，點選後**以使用者訊息**「"Which deployment strategy?" — I selected: Blue-green」送回，卡片換成「Response sent.」。文件直說「對話沒有被擋住，使用者可以繼續打字，真正的等待只能靠伺服器邏輯」——也就是機制 B。

### 3.3 OpenAI Apps SDK〔文件〕

見 1.3。和 MCP Apps 同源；ChatGPT 特有的是 `widgetState`、`requestModal`、`requestCheckout` 等。

### 3.4 Google A2UI〔文件，草稿〕

來源：[A2UI v0.9](https://a2ui.org/specification/v0.9-a2ui/)、[Message reference](https://a2ui.org/reference/messages/)

- 宣告式、串流的 JSON UI 協定：agent 送 `createSurface`（`surfaceId`、`catalogId`）、`updateComponents`（扁平元件清單，一個 id 必須是 `root`）、`updateDataModel`、`deleteSurface`；使用者互動回傳 `action`（`name`、`surfaceId`、`sourceComponentId`、`timestamp`、`context`）。
- 重點是 **catalog**：客戶端事先宣告自己有哪些元件，agent 只能用這些；不送可執行程式碼，用原生元件畫。這是「應用程式定義元件」路線的協定化版本，和 pi mobile 自己的卡片元件同一個方向。v0.9 仍標為草稿。

---

## 4. 行動與聊天平台

| 平台 | 機制 | 回答方式 | 回答後 | 細節 |
|---|---|---|---|---|
| Slack Block Kit〔文件〕 | 訊息裡的按鈕、選單 | `block_actions` POST 到你的 URL，**3 秒內要回 200** | 用 `response_url` 帶 `replace_original: true` 把原訊息換成結果（例如「Jane 已核准」）；`response_url` **30 分鐘內最多 5 次** | [Handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction)；按鈕可帶 `confirm` 對話框做二次確認 |
| Telegram〔二手，函式庫文件〕 | inline keyboard（訊息上的按鈕）／reply keyboard（取代鍵盤） | inline：`callback_query`，`callback_data` 1–64 bytes；**不呼叫 `answerCallbackQuery` 客戶端會一直轉圈**；reply keyboard：點選就是送出那段文字 | `editMessageReplyMarkup` 移除或改按鈕；reply keyboard 可設 `one_time_keyboard` | [python-telegram-bot](https://docs.python-telegram-bot.org/en/v12.6/telegram.callbackquery.html)、[grammY types](https://github.com/grammyjs/types/blob/v3.0.3/markup.ts) |
| LINE〔文件〕 | Quick reply，最多 13 個 | 點選＝送出訊息或 postback | **點了就消失**；相機、相簿、日期時間選擇、位置除外，這些等資料送出才消失 | [Use quick replies](https://developers.line.biz/en/docs/messaging-api/using-quick-reply/) |
| RCS（Google）〔二手〕 | suggested replies／suggested actions chip，每則最多 11 個 | reply 送回顯示文字＋`postbackData`（≤2048 字元）；action（開網址、撥號）**不會送回對話** | chip 點了就消失 | [AWS RCS suggestions](https://docs.aws.amazon.com/sms-voice/latest/userguide/rcs-suggestions.html) |
| Apple Messages for Business〔文件〕 | list picker（可多選）、time picker、Apple Pay、驗證 | 選完後客戶端用 `ReplyMessage` 樣式產生回覆泡泡；多選時每項各一則 | **原請求泡泡（InteractiveResponse）與回覆泡泡分開**，回覆泡泡顯示選了什麼 | [Interactive Message Types](https://register.apple.com/resources/messages/msp-rest-api/type-interactive) |

共同點：**選項的顯示文字和機器值分開**（Slack `value`、Telegram `callback_data`、RCS `postbackData`、MCP `oneOf.const/title`）；**選項是一次性的**（點了就消失或被改寫）；伺服器要很快確認（Slack 3 秒、Telegram 轉圈），否則使用者以為沒按到。

---

## 5. 綜合：每個人都要做的設計決定

### 5.1 阻塞工具 vs 下一則訊息

| | 阻塞式（gate） | 下一則訊息（ask） |
|---|---|---|
| 代表 | Claude SDK、Vercel、LangGraph、AG-UI、OpenAI Agents、MCP elicitation | LINE/RCS/Telegram quick reply、FastMCP Choice、pi `ask_user` |
| 答案在哪 | 工具結果 | 使用者訊息 |
| 打字代替點選 | 必須另外處理（Claude `response`、Vercel 補 tool result、AG-UI 要 resume） | 天然支援，打字就是答案 |
| 適合 | 動作要等核准才做（寄信、付款）、外部協定要求（MCP） | 模型想問偏好、下一步 |
| 成本 | 待處理狀態要存活（重啟、背景）、要有過期 | 模型可能「問完繼續講」，需提示詞要它結束回合 |

結論：**兩種都要，但分屬不同元件**。問題卡用 B，確認卡（MCP 表單、自己工具的寄送）只能是 A，因為 MCP 伺服器在等 `inputResponses` 才會真正寄出。

### 5.2 誰畫 UI

- 應用程式元件（Claude、Vercel、assistant-ui、CopilotKit、A2UI catalog、MCP 表單）：一致、可及性好、好量效能、安全；限制是只能畫事先做好的種類。
- 伺服器 HTML（MCP Apps、Apps SDK）：任意 UI，但要沙箱 iframe、CSP、UI 發起的工具呼叫要再核准，難截圖、難審查（SEP-1865 自己列的理由）。
- MCP 表單 elicitation 剛好是中間：伺服器給**受限的 schema**，客戶端用自己的元件畫。這是 pi mobile 最划算的入口。

### 5.3 選項的 schema

- 選項數：2–4（Claude、Grok、pi），平台上限 11–13（RCS、LINE）。
- 顯示文字 vs 值：協定都分開（`title`/`const`）；Claude 以 label 當值、題目文字當 key（簡單但題目文字改了就對不上）。
- 描述：Claude 每個選項有 `description`；Grok 和 pi 沒有。pi 的 DESIGN 原則（不要多餘的次要說明）傾向不加。
- 推薦：Claude 要模型把推薦放第一個並標「(Recommended)」；pi 是「最可能的放第一個」。
- 多選：Claude `multiSelect`、MCP array enum、Apple list picker 都有；聊天平台的 quick reply 都沒有（點一下就送出）。多選必須有「送出」按鈕，互動和單選不同。
- 自由輸入：Claude「Other」＋把打的字當答案；Grok/pi「或在下方直接回答」用輸入框代替 Other。

### 5.4 狀態

最大公約數（綜合 MCP、AG-UI、Vercel、Grok）：

```
open → submitting → accepted(value) | declined | cancelled | expired | failed(reason)
```

- `declined`（明確說不）和 `cancelled`（沒選、關掉、被打斷）要分開：MCP 規定、伺服器可能對兩者做不同處理（decline 提供替代、cancel 之後再問）。
- `expired`：AG-UI `expiresAt`、Slack `response_url` 30 分鐘、MRTR `requestState` TTL。
- `submitting`：點了、還沒確認（Telegram 轉圈、Slack 3 秒）。防連點的就是這個狀態。
- Grok 的「Always allow」是卡片之外的持久設定，不是卡片狀態。

### 5.5 回答後在歷史裡的樣子

- 一律**就地改寫**原卡片，不留可點的按鈕。差別只在留多少：只留選中的（pi、Apple 回覆泡泡）、換成一句結果（Slack、FastMCP、Grok「已傳送 · 收件人」）、整組消失（LINE、RCS）。
- 回看歷史時要能還原狀態：OpenAI 用 `widgetState` 持久化；AG-UI/Vercel 從訊息 part 狀態算出來。**狀態應從持久化的對話推得，不另存一份**。

### 5.6 可及性

- 文件幾乎沒談〔推論〕。可做的基本盤：真正的 `<button>`、停用而不是隱藏仍在等待的選項、字母 A–D 不只是視覺（螢幕閱讀器念「A，選項文字」）、觸控目標至少 48dp（Android 準則）。
- 狀態改變（已傳送、已失效）要在卡片本身以文字呈現，不只靠顏色。

### 5.7 停用、編輯、撤回

- 沒有任何一家提供「撤回已選答案」。原因〔推論〕：答案已進入模型上下文，撤回等於改寫歷史。要改就再說一句話。
- **送出前的編輯**是有的：MCP 規定表單送出前可檢視修改；LangGraph `edit`、Claude `updatedInput` 讓人改參數再執行。對寄信來說，確認卡就是唯一的「撤回點」。

---

## 6. 給 pi mobile `interaction` 的建議

先看現狀〔讀碼〕：
- `src/interaction/tool.ts`：`ask_user` 立即回傳「End your turn now… the user's answer comes as their next message」——機制 B。
- `src/interaction/answers.ts`：狀態從對話推得（`open | answered`，答案是下一則使用者訊息的文字），符合「值只存一次」。
- `src/interaction/forms.ts`：`Forms.ask(callId, form, signal)` 回傳 Promise、`answer(callId, FormAnswer)` 結算、abort 時結算成 `cancel`——機制 A，但待處理表單**只在記憶體裡**。
- `src/interaction/QuestionCard.tsx`：回答後只留選中的選項；若使用者打的字不等於任何選項，所有選項都隱藏，卡片只剩題目（目前無提示，見 6.6）。

### 6.1 先做哪些種類（依序）

1. **確認卡（MCP 表單 elicitation）**：最先做，因為寄送已被 MCP 伺服器擋住，沒有它就寄不出去。先支援兩種形狀：
   - 空 schema 或只有一個 boolean：純確認，按鈕「傳送」/「不要」。
   - 扁平 schema：把每個欄位畫成可編輯的列（string/number/boolean/enum/多選 enum 都是封閉集合，spec 刻意限制成這樣），預填 `default`。郵件類的「收件人、主旨、內文」就是這種。
2. **連接卡（MCP URL 模式）**：顯示服務名和**完整網址、網域強調**，按「連接」用 Custom Tabs 開（不是 app 內 WebView，規格要求 LLM 和客戶端看不到內容），回來後重送；卡上有「重試」「取消」（規格 SHOULD）。
3. **多選**：等真的有第三個需要它的情境再加到 `ask_user`（三次原則）。它需要「送出」按鈕，互動不同於單選。
4. **「要設成例行任務嗎？」**：不需要新元件，就是 `ask_user` 兩個選項；接受後由排程工具做事、對話裡一行結果。
5. **進度/狀態卡**：pi 已有工具列；ChatGPT 的 `invoking/invoked` 短字、Gemini 的工作面板是參考，但不屬於 `interaction`，先不做。
6. **不做**：伺服器提供的 HTML（MCP Apps）。WebView 裡再開沙箱 iframe、CSP、UI 發起工具呼叫的二次核准、效能量測，都是大成本；等有具體 MCP 服務需要才評估。

### 6.2 共用的形狀

一個卡片聯集，加一個結算聯集；結算形狀直接用 MCP `ElicitResult`，因為它是最通用的（現有 `FormAnswer` 應該就是它）：

```ts
type Card =
  | { kind: "choice"; from: "model"; question: string; options: readonly string[] }
  | { kind: "form"; from: "mcp"; service: string; message: string; schema: FlatSchema }
  | { kind: "link"; from: "mcp"; service: string; message: string; url: string };

type Settled =
  | { action: "accept"; content?: Record<string, Value> }
  | { action: "decline" }
  | { action: "cancel"; reason: "typed" | "aborted" | "expired" };

type CardState = { state: "open" } | { state: "submitting" } | { state: "settled"; result: Settled };
```

- `choice` 是機制 B，`form`/`link` 是機制 A；兩者共用卡片外殼（白色圓角、標題列、底部提示）和狀態呈現，不共用結算路徑。
- `from` 決定標題列：MCP 卡**必須顯示服務名**（規格 MUST）。
- 狀態**從對話推得**：`choice` 看下一則使用者訊息（現狀）；`form` 的結果寫進那次工具呼叫的 tool result，歷史就能畫「已傳送 · 收件人」，不需要另存。

### 6.3 使用者打字代替點卡（最重要的決定）

- `choice`：打字就是答案（現狀，對）。
- `form`（阻塞中）：建議**打字＝把這張卡結算成 `cancel`（reason: typed），再把文字當下一則訊息送給模型**；卡片改成「已略過」。這對應 Claude 的 `response`、Vercel 的「先補 tool result 再送新訊息」、Grok 的「Deny 後要等下一則訊息才再試」。替代方案是送出前擋住輸入框，但違反「或在下方直接回答」的一致性。這點需要使用者同意。
- 依 MCP，`cancel` 與 `decline` 分開：按「不要」是 `decline`，打字略過是 `cancel`。

### 6.4 逾時與重啟

- 客戶端不設逾時（Claude SDK 可無限等；MCP 不規定）。
- 〔2026-11-04 實作後更正〕確認卡不是從對話推得，而是畫 `Forms` 記憶體裡還在等的那幾筆，放在對話最後（codemode 腳本裡的呼叫 id 對不上畫面上的那一步，所以依對話而不是依呼叫 id 找）。App 被殺掉時卡片跟著消失，那次工具呼叫以「被中斷」收尾；S24 上實測，模型因此說「無法確認是否已寄出」而不重寄，使用者再說一次才重送，伺服器重新要求確認。下面這段是實作前的推測，留作對照：
- 但 `Forms` 的待處理請求在記憶體裡，**app 被殺掉後歷史裡會留下一張永遠點不了的卡**。建議：重新開啟時，沒有結果的 `form` 卡推得為「已失效」，對應工具呼叫以 `cancel` 收尾，模型得知後可以再試一次（重送會拿到新的 `input_required`，因為 MRTR 是無狀態的）。〔推論：是否可以在重啟後直接用舊 `requestState` 重送，取決於伺服器 TTL，不要依賴。〕
- 伺服器 TTL 到期，重送時回錯誤或再要一次：錯誤顯示在**卡片本身**（「已過期，請再說一次」），不要 toast。

### 6.5 防連點與「送出中」

- 第一下就進 `submitting`、停用所有按鈕；`Forms.answer` 已經是「拿到就刪」，天然只結算一次〔讀碼 `forms.ts`〕。OpenAI Agents 文件特別提醒手機核准要「原子地消耗」防重放。
- 真正的一次性保證在伺服器（MRTR 規格明說 `requestState` 不保證只用一次）。

### 6.6 其他踩過的坑

- **選項按題目文字或顯示文字對應**很脆弱（Claude 以題目文字當 key）。pi `answers.ts` 以「下一則訊息等於選項文字」判斷選中；使用者打了別的字時卡片只剩題目〔讀碼 `QuestionCard.tsx`〕。可接受（使用者的訊息就在下方），但可以考慮讓卡片收成只剩題目＋一個淡色「已在下方回答」，避免看起來像壞掉的空卡。
- **模型問完不結束回合**：FastMCP 承認「等待只是建議」。pi 的 tool result 已要求「End your turn now」；可在 prompt 測試裡量它的遵守率。
- **LangGraph 重跑**：MRTR 重送同一個 `tools/call` 時伺服器從頭執行；客戶端**不要**因此再呼叫一次模型或重做其他副作用，只重送那次 MCP 呼叫。
- **destructiveHint 只是提示**：OpenAI 明說註記不等於授權。pi 對自己工具（`*_as_user`）的確認仍應由 app 決定，不能只看 MCP 伺服器的註記。
- **敏感資料不進表單**：MCP 禁止表單要密碼/token/付款；pi 應拒絕畫 `format` 看起來像密碼的欄位嗎？規格只約束伺服器，客戶端可以不做〔推論〕——先不做，避免過度設計。
- **多張卡同時待處理**：CopilotKit 修過這個 bug；AG-UI 要求一次 resume 全部。MRTR 一次 `inputRequests` 可有多個 key，pi 應把它們畫在同一張卡裡、一次送出，而不是多張卡。
- **「永遠允許」**：Grok、Claude、OpenAI Agents 都有。它是設定（每個 Bot、每個工具），不是卡片狀態；等使用者要求再做。

### 6.7 對未來的影響（若照此設計）

- 移除的紅旗：卡片外殼與狀態呈現只有一種做法；結算形狀只有一種（MCP `ElicitResult`）；狀態從對話推得，不另存。
- 新增的風險：`choice`（B）與 `form`（A）共用外殼但結算路徑不同，新貢獻者可能照抄錯的那一個——應由型別區分（`from: "model" | "mcp"` 決定走哪條），不靠說明文字。
- 留待以後：多選、「永遠允許」、MCP Apps HTML、重啟後恢復待處理表單。
