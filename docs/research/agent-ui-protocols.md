# A2UI 與 AG-UI：值不值得用（2026-11-15）

使用者問：「A2UI 和 AG-UI 到底是不是垃圾」。結論：都不是垃圾，但解的是 pi mobile 現在沒有的問題；A2UI 的「目錄」概念值得借，AG-UI 現在不需要。

查證來源：A2UI 讀了 [github.com/google/A2UI](https://github.com/google/A2UI) 的 README 和 releases；AG-UI 讀了 [github.com/ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) 的 README 和 [docs.ag-ui.com](https://docs.ag-ui.com/introduction)。部落格說 A2UI「1.0 在 11-11 發布」，repo 裡沒有叫 1.0 的 release：各套件分開發版（CLI 0.3.0、core 0.6.0、agent-sdk 0.11.0，都在 11-10、11-11），規格文件標 v1.0，roadmap 在收 v1.1 的需求。

## 它們各是什麼

| | A2UI（Google） | AG-UI（CopilotKit 起頭） |
|---|---|---|
| 解什麼 | agent 要給使用者一個畫面，而不是一大段文字 | agent 後端和前端 App 之間怎麼傳事件 |
| 怎麼做 | agent 送宣告式 JSON（`createSurface`、`updateComponents`、`deleteSurface`、雙向的函式呼叫），用戶端只用自己**目錄**裡的元件畫；目錄沒宣告的函式會被拒絕，函式還標明誰能呼叫（只有 agent、只有畫面、兩者） | 約 16 種標準事件（文字串流、工具呼叫、狀態同步…），走 SSE、WebSocket 或 webhook |
| 用戶端 | Lit、Angular、React、Flutter、SwiftUI；沒有 Android 原生的 renderer | CopilotKit、終端機、Slack、Teams、React Native |
| 治理 | Google 的 repo（a2ui-project） | 沒有基金會，CopilotKit（創投資金）主持；被批評為軟性綁定 |
| 採用 | Google、Atlassian 等（二手來源） | Microsoft Agent Framework、Google ADK、AWS Strands、Mastra、Pydantic AI 等第一方整合；社群有 Claude Agent SDK、Cloudflare Agents |
| 關係 | AG-UI 的文件把 A2UI 列為它支援的「生成式 UI」規格：AG-UI 是管線，A2UI 是管線裡可以送的一種內容 | |

## 對 pi mobile

- **AG-UI 現在不需要**。它的價值在 agent 和畫面分在兩台機器時，有一套共同的事件格式。pi mobile 的 agent 和畫面在同一個 WebView 裡，畫面直接讀 pi-durable 的 entries 和 live state，中間沒有網路邊界可以標準化。它可能有用的地方是工作後台要看**電腦上**的 agent，但 Herdr、Rex、Claude Code、Codex 都不講 AG-UI，我們讀的是它們自己的 CLI；等哪天電腦上的 agent 普遍講 AG-UI，`src/computer-agents` 可以多一個讀法。
- **A2UI 的概念我們已經在用一部分**：問題卡、表單卡、權限卡、結果卡，都是模型送結構化的工具參數，App 只用自己的元件畫（`src/interaction/`）。這就是「信任的元件目錄」。
- **值得借的是目錄的嚴格度**。Bot 做的網頁（`PageFrame`，沙箱 iframe 裡的 HTML）是另一條路：彈性大，但畫面風格、可存取性和安全都靠沙箱守。若之後要讓 Bot 產生互動式的小畫面（表格、圖表、核准清單），先考慮 A2UI 式的「宣告式描述 + 我們的元件目錄」，而不是更多的任意 HTML。
- **不直接採用 A2UI 規格**：Android 沒有原生 renderer（我們也不需要，畫面在 WebView），它的 React renderer 會帶進另一套元件和樣式，跟 DESIGN.md 的設計語言衝突；規格各套件版本還在快速變。借概念（目錄、函式的呼叫者限制），不借套件。
