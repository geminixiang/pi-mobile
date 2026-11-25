# Codex 電腦／瀏覽器操作：pi mobile 可以學什麼

2026-11-15。Codex 淺複本：`../research/codex`，commit `5cb38e79842a0e0a6dca5bb97874163e8ee50129`；pi：`f5f01fe4ba85fbaa3175c93d2aa60a44894b7c0b`。下文 `C/` 代表該複本的 `codex-rs/`；其餘路徑屬於 pi。**讀碼、公開文件、實跑、推論分開標示**。沒有操作帳號、登入網站或執行 Codex；沒有提交。

## Codex：公開原始碼到哪裡為止

**讀碼**：複本未見完整操作 driver；可追到工具載入、MCP、核准與證據處理：

- `node_repl`、`cua_repl`，以及 `codex_apps` 下的 `connector_openai_browser` 是被辨識的操作入口（`C/protocol/src/mcp.rs:35-64`）。名稱、說明、input/output schema 由 MCP 定義轉成模型工具（`C/tools/src/responses_api.rs:121-172`）。`js` 的 `{code:string}` 與「Run JavaScript in the test Node REPL」只出現在測試 server，**不是正式工具規格**（`C/rmcp-client/src/bin/test_stdio_server.rs:175-190`）。
- 實際邊界是 `PreparedMcpCall.call_with_admission` → MCP client `call_tool`，帶 arguments、metadata、剩餘 timeout（`C/core/src/mcp_tool_call.rs:538-553`；`C/codex-mcp/src/binding.rs:430-502`）。未找到 backend 的 DOM／無障礙樹、座標、等待、驗證完整實作；不能說 CLI 自帶 Playwright，或 MCP 都是託管服務。
- `turn_ended` 清理 hook 涵蓋 Stop／Interrupt／SubagentStop，不保證遠端動作取消（`C/plugin/src/bundled_hooks.rs:26-110`）。

**公開文件**：[桌面產品][desktop]有可撤銷的逐 App 授權；OS 螢幕／輔助使用權限與 shell sandbox 分開。macOS 可背景操作，Windows 用前景桌面；可用已登入 session，但敏感流程應有人看著；不能代批 OS 安全提示／管理員驗證。[Browser][browser]不供 CLI／IDE 使用；桌面版獨立 profile、逐站權限，不繼承個人 cookies。該頁雲端版的登入保護不能套到桌面版。

**公開文件，非 Codex 規格**：[Responses computer guide][api]提供 `{type:"computer"}`，模型回 `computer_call.actions[]`，應用程式依序執行，再送同一 `call_id` 的 `computer_call_output`，內含 `computer_screenshot`、`image_url`、`detail:"original"`。`completed` 只是生成完成；`previous_response_id` 延續對話，不保存桌面狀態。

[整合範例][integration]的 action 欄位為 click `{x,y,button}`、double_click／move `{x,y}`、drag `{path:[{x,y},…]}`、scroll `{x,y,scroll_x,scroll_y}`、keypress `{keys}`、type `{text}`、wait／screenshot。這是範例 handler，非完整 schema。API 回看截圖，不代表 Codex Browser 不用 DOM。舊 `computer_use_preview` 為單一 `.action`。

## 核准、提示詞與敏感資料

**讀碼**：外層 MCP 可先拒絕／要求核准（`C/core/src/mcp_tool_call.rs:245-383`）；操作端收到 host 提供的 `browser_use`／`computer_use` confirmation policy（`:1576-1606`）。巢狀 elicitation 能綁回原呼叫；敏感標記要求同步審查，但 User reviewer／Full Access 有不同略過分支，**不是所有動作必問人**（`C/core/src/session/mcp.rs:1033-1127`）。

Guardian 指示：按實際後果審查巢狀動作；登入、擴權、重大操作需具體授權；網站不可信，敏感外送需資料與目的地授權；送出前核對內容（`C/prompts/templates/guardian/node_repl_policy.md:1-11`）。這是**審查 prompt**，非不可繞過的保證。逐站／App 政策型別不證明 backend 有執行（`C/config/src/browser_use.rs:9-21`、`C/config/src/computer_use.rs:9-34`）。

**公開文件**：[整合指南][integration]要求 executor 在第一個未獲授權的風險動作前停住批次；不能只靠 prompt，產生的程式也要經執行端 gate。敏感欄位輸入本身可能外送，不必等 Submit；最終改密碼等要交還人。建議隔離環境、允許範圍、期限／步數／成本上限及取消；Node `vm` 不是安全邊界，client timeout 不代表程式停止。這些是整合者責任，不是公開 Codex 已實現的完整保證。

## 成本與測試證據

**讀碼**：一般工具輸出可按 token 截短（`C/core/src/context_manager/history.rs:680-690`）；遠端壓縮按預算取較新項目，保留結構化工具結果整體（`C/core/src/compact_remote_v2.rs:700-788`）；圖片集中處理縮放／上傳及 inline fallback，保留 replay 原圖（`C/core/src/image_preparation.rs:425-537`）。沒有找到「操作模型永遠只保留最後 N 張截圖」的證據。

Guardian **另有**每筆約 6000 tokens、總共 8 MiB 的審查證據 buffer，截短時保留尾端及來源，淘汰圖片／舊證據並記錄省略數；不是操作模型歷史（`C/ext/guardian-reviewer/src/node_repl_review_evidence.rs:23-24,67-109,133-239`）。[Computer History][history]則是選擇開啟的互動事件記憶，並非上述 token pruning。

**只讀、未跑**：Codex 測試覆蓋 issuing-step metadata 固定與審查者不接收 actor policy（`C/core/src/mcp_tool_call_tests.rs:1306-1413`）、證據預算／尾端／淘汰（`C/ext/guardian-reviewer/src/node_repl_review_evidence_tests.rs:84-220`）。它們不是實際網站完成率 eval；本次未取得可重現的端到端操作評測。

## 對照 pi mobile（讀碼；Codex 文件部分如上）

| 面向 | Codex | pi mobile 現況 |
|---|---|---|
| 觀察 | 複本未見完整 backend；API 截圖迴圈 | 手機 stable id／label／state／座標，截圖選用（`src/phone-screen/tool.ts:118-128`）；Browser DOM 編號會重編（`src/browser/tool.ts:201-207`）；電腦 accessibility 文字優先（`src/agent/tools/computer.ts:40-65`）。 |
| 動作／驗證 | MCP／JS 接點；API 有序批次，不等於任務成功 | 手機 known batch、失敗停止、`expect`；電腦回 after-look 與已跑／未跑步驟（`src/phone-screen/tool.ts:138-155`；`host/computer/computer.go:924-943`）。 |
| 等待 | MCP deadline；backend 等待未知 | 手機 `wait_for`、`scroll_to` 最多 12 次／15 秒；Browser 文字等待最多 20 秒、接手最多 10 分鐘（`src/phone-screen/tool.ts:139`；`src/browser/tool.ts:205,236-238`）。 |
| 安全 gate／隔離 | 政策、elicitation、Guardian；桌面權限不等於 sandbox | 已移除通用核准（`docs/tools.md:85-89`）。Browser 確認靠 prompt；手機只要求告知（`src/phone-screen/tool.ts:141`），非硬 gate。背景螢幕與電腦桌面都不是安全沙箱（`docs/design/background-screen.md:62-86`；`src/agent/tools/computer.ts:46`）。 |
| 憑證／登入 | 產品可能操作既有 session；不能推論開源庫藏密碼的方式 | Browser 保留 Bot cookies／登入；prompt 禁打密碼，登入／captcha／付款交人（`src/browser/tool.ts:201-207`）；不應推成三個 backend 都有憑證隔離。 |
| token 效率 | 一般截短／圖片處理；審查證據另外限額 | 文字優先、changed lines；Browser 要求只印所需欄位（同上 `:206`）；電腦穩定編號／差分／JPEG70（`host/computer/computer.go:313-335,417-475`）。 |
| 擴充 | MCP schema 動態載入、plugin 清理接點 | `phone_open_as_user` 常駐並載入讀／操作／筆記（`src/phone-screen/tool.ts:159-169`）；電腦走配對 host MCP（`src/agent/tools/computer.ts:12-32`）。`src/screen/driver.ts:19-70` 有共用型別，但搜尋引用僅見 `test/screen-observation.ts`，尚非 runtime 統一 driver。 |

## 採用順位（推論，不是已量得的改善）

1. **先討論窄授權／接手契約**。收益：避免未授權送出；成本高：executor／恢復點需一致；風險：誤擋、核准疲勞。pi 已取消核准，須先列失敗案例、頻率、代價取得同意。用本機測試頁／App 量未授權副作用、誤問、恢復率。
2. **延伸 `expect` 與動作後證據**。收益：減少錯點／誤報完成；成本中：綁定 surface／目標／結果；風險：證據過期、延遲。以 `Platform` 跑頁面改變、同名目標、失敗中斷，量錯點／誤報／延遲。接入既有 scoped refs／diff（`src/screen/encode.ts:11-62`），不另造 verifier。
3. **量測歷史圖片／文字預算**。收益：少重讀舊畫面；成本中；風險：遺失授權／結果證據。保留來源、action/result 配對；勿照搬 Guardian 限額。用 fixtures 比 tokens／呼叫數／完成率，再跑 S24 tool-cost 與自然問題（`docs/tools.md:225-233`）；字元數不是 token 實測。
4. **統一期限、取消與 capabilities**。收益：有界停止；成本中高；風險：逾時重試造成重複副作用。量測停止延遲、逾時後副作用、接手恢復；沿用等待上限，不另造排程器。

**General first**：不內建 App／網站／語言名單；查裝置、讀自學筆記，至少兩種手機驗證（`AGENTS.md:29-31`）。mika 的入口／筆記已做（[references.md](references.md)）；Poki 的 verifier／deadline 只是研究（`docs/research/poki.md:35-38`）。iOS 現用 in-process XCTest，非舊 WDA（`docs/design/background-screen.md:88-111`）。

**實跑與限制**：離線執行 `node --import ./test/vite-imports.js test/screen-observation.ts`、`test/phone-screen-steps.ts`、`test/browser-steps.ts`，三者通過；沒有裝置量測，沒有跑完整 `npm run check`。公開文件以無登入 HTTP 讀取；`web_search` 已嘗試，但 provider 未設定、替代 provider 模組不相容，故沒有搜尋結果可佐證。

**對未來的影響**：若採用，讓觀察、授權、停止各有單一 owner；保留既有文字優先／批次／按需載入。採用仍待設計與量測，本次不改產品。

[desktop]: https://developers.openai.com/codex/computer-use
[browser]: https://developers.openai.com/codex/browser
[api]: https://developers.openai.com/api/docs/guides/tools-computer-use
[integration]: https://developers.openai.com/api/docs/guides/tools-computer-use-integration
[history]: https://developers.openai.com/codex/customization/computer-history
