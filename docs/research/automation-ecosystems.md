# 自動化生態：IFTTT 這一類工具，pi-mobile 能借用什麼

研究日期：2026-10-26。範圍是官方文件、規格和公開原始碼的說明；沒有安裝或實測任何一個（S24 正借給其他測試）。數字（整合數量、版本）都是當天官方頁面上的，會變。

## 先說結論

pi-mobile 的排程已經是 IFTTT 的形狀：**When**（時間、Wi‑Fi、地點、通知、藍牙…）→ **If**（時段、間隔、`only_if` 判斷）→ **Do**（agent run）→ **Tell**（[design/triggers.md](../design/triggers.md)）。IFTTT 自己的服務模型也是三種元件：trigger、query、action [I1]，正好對上 pi 的「事件來源」與「每類東西都能讀、也能改」（[design/phone-state.md](../design/phone-state.md)）。

差別在 Do：IFTTT、Tasker 跑固定的動作，pi 每次都叫模型。所以生態能補 pi 的地方有四個，依價值排：

1. **固定規則不叫模型**：「連上 Zhao → 鈴聲 30%」這種，建立時由 agent 寫成一段 codemode 腳本，觸發時直接跑，不再呼叫模型。這不是接別人的生態，是借 IFTTT 的想法；pi 的工具本來就是有型別的函式，腳本執行環境（QuickJS）也已經在。
2. **外部服務的動作，接 MCP，不自己寫**：Zapier（9,000+ app）[Z1]、IFTTT（1,000+ 服務）[I2]、Activepieces（771 個，MIT，可自架）[A1][A2]、Home Assistant（1,410 個整合）[H1][H2] 都有官方 MCP server。pi 已經是有 OAuth 的 MCP 客戶端，Zapier 已在市集裡。
3. **外部事件當 When**：Huginn、Home Assistant、n8n、IFTTT 都能在事件發生時發 webhook；pi 只要有**一個**收 webhook 的入口（`triggers.md` 待決定第 3 題），整個生態的事件就都能觸發 agent。
4. **Android 不准的手機動作，在無障礙之前多一層 Shizuku**：Shizuku（Apache-2.0）讓 app 以 adb shell 身分執行特權操作，Android 11 起可以在手機上自己配對、不用電腦 [S1][S2]；例如 `cmd wifi set-wifi-enabled` 直接開關 Wi‑Fi。代價是每次重開機都要重新啟動它。

不建議的：把 pi 變成 Tasker 的外掛主機去跑別人的 plugin（設定要開對方的畫面，agent 沒辦法自己設）；用 AppFunctions 呼叫別的 app（要系統允許清單，一般 app 拿不到）[F1]。

## pi-mobile 現況（對照用）

- **When**：時間（每天、一次）、耳機、充電、Wi‑Fi（可指定名稱）、通知（app、文字）、解鎖、電量低、換時區、新照片、藍牙裝置、活動（走路、開車…）、到達或離開地點（`src/agent/triggers.ts`）。原生端判斷，不輪詢。
- **If**：原生端的時段、星期、間隔；觸發後、叫醒 agent 前的 `guards` 與 `only_if`（classifier 一次約 0.000013–0.000024 美元）。
- **Do**：一律是 agent run。`triggers.md`：「觸發之後不跑 agent、改跑固定動作或腳本，是之後另一層的事。」
- **外部服務**：MCP 客戶端（Streamable HTTP、OAuth 動態註冊、本機跳轉網址），市集 26 個服務，含 Zapier（`src/agent/mcp-catalog.ts`）。
- **外部事件**：沒有。`triggers.md` 待決定第 3 題（FCM 要每個使用者自己建 Firebase 專案；UnifiedPush 要另外裝推播 app，例如 ntfy）。

## 生態地圖

### 一、雲端與自架的整合平台（外部服務的「動作」與「事件」）

| 專案 | 授權 | 規模 | 怎麼接 | 對 pi 的意義 |
|---|---|---|---|---|
| **Zapier** | 閉源 | 9,000+ app、40,000+ 動作 | 官方 MCP server（`mcp.zapier.com`）；使用者在網頁上挑要開放的動作 | 已在市集。每次成功的工具呼叫扣 **2 個 Zapier task** [Z2]，要在說明裡讓使用者知道 |
| **IFTTT** | 閉源 | 1,000+ 服務 | 官方 MCP server `https://ifttt.com/mcp`，OAuth；免費版只能探索、跑免費的 Applet，執行動作要 Pro，query 要 Pro+ [I2][I3] | 可加進市集；也能用 Applet 把 IFTTT 的事件轉成 webhook 送給 pi（要有第 3 點的入口） |
| **Activepieces** | 核心和社群 pieces 是 MIT；企業功能另有授權 | 771 個 pieces | 每個專案一個內建 MCP server（OAuth），`ap_run_action` 執行任一 piece 的動作 [A1][A2] | **可自架**的 Zapier：資料不經第三方。適合有電腦（Mac mini）的使用者，用 pi 的電腦連線或 Tailscale 連 |
| **n8n** | Sustainable Use License：原始碼公開，**不算開源** [N2] | — | MCP Server Trigger 節點把一個 workflow 變成 MCP 工具；另有整個 instance 的 MCP server [N1] | 能用，但授權限制商業再散布；不放進「推薦」 |
| **Node-RED** | Apache-2.0；第三方節點各有授權 | 6,257 個節點套件、3,125 個分享的流程 [R1] | HTTP 節點收發 webhook | 物聯網圈的事件來源；要搭配第 3 點的入口 |
| **Huginn** | MIT | — | WebhookAgent 收、PostAgent 發；agent 之間是事件的有向圖 [G1] | 仍在維護（2026-10-13 發布 v2026.10.14）[G2]。最像「自架的 IFTTT」，適合當事件來源：監看網頁、RSS、email |
| **Automatisch** | 社群版 AGPL-3.0，`.ee.` 檔案另有授權 | — | 自架 | 有開放議題質疑社群版能否不靠企業元件運作；不推薦 |

### 二、智慧家庭

| 專案 | 授權 | 規模 | 怎麼接 |
|---|---|---|---|
| **Home Assistant** | Apache-2.0（Android companion app 也是 Apache-2.0）[H3] | 官方整合 1,410 個 [H1] | 官方 **MCP Server** 整合：設定 › 裝置與服務 › 加入整合 › Model Context Protocol Server，OAuth；預設開放所有 LLM API、要管理員帳號，可以在整合的設定裡縮小 [H2] |

有 Home Assistant 的使用者，pi 透過一個 MCP 連線就能讀寫家裡所有裝置的狀態，正好延伸「每類東西都能讀也能改」到手機以外。HA 在家裡、手機在外面時，要 HA 對外可連（Nabu Casa 或 Tailscale）。HA 的自動化也能在事件發生時呼叫 webhook 通知 pi（第 3 點）。

### 三、手機上的自動化 app

| App | 授權 | 別的 app 怎麼呼叫它 | 備註 |
|---|---|---|---|
| **Tasker** | 閉源、付費 | `TaskerIntent` 依名稱執行使用者的 task，需使用者在 Tasker 打開「Allow External Access」並授予 `PERMISSION_RUN_TASKS` [T2]；也能用「Intent Received」事件接任意廣播 [T4] | 外掛協定是公開的 Locale plugin API：`EDIT_SETTING` 開外掛的設定畫面回傳 Bundle，`FIRE_SETTING` 執行 [T1]。Tasker 6.5 有 AI 產生器 [T3]；社群有 `tasker-mcp`（讓 agent 讀改 Tasker 專案，未發布到 npm）[T5] |
| **Automate**（LlamaLab） | 閉源 | 廣播 `com.llamalab.automate.intent.action.START_FLOW`，data 是使用者那邊的 flow URI，extras 當 payload [M1] | flow URI 每台裝置不同，要使用者複製給 pi |
| **MacroDroid** | 閉源 | Webhook（URL）觸發：`https://trigger.macrodroid.com/<裝置>/<識別>`；也有「Intent Received」 [D1] | 經雲端轉發，pi 在手機上用不到 URL；用 intent 即可 |
| **Automation**（Jens Schröder） | GPL-3.0+ | — | F-Droid 1.8.8（2026-08-26）；觸發有時間、地點、充電、Wi‑Fi、藍牙、NFC、通知，動作有聲音設定、開 app、HTTP、執行指令 [J1]。可以讀它的程式碼當「Android 上哪些事做得到」的對照，GPL 不能直接抄進 pi |
| **Termux** | GPL-3.0 | `RUN_COMMAND` intent，要使用者授權 [X1] | 真正的 Linux 指令；pi 已有 just-bash 和電腦，不需要 |

### 四、權限層

| 機制 | 能做什麼 | 限制 |
|---|---|---|
| **Shizuku**（Apache-2.0） | app 透過 `UserService` 以 adb shell（UID 2000）身分執行：例如 Wi‑Fi 的 `cmd wifi set-wifi-enabled enabled|disabled` [S1]；其他項目（藍牙、行動數據、定位…）的 shell 指令沒有在官方文件確認，要實測 | 使用者要開開發人員選項、無線偵錯，在 Shizuku 裡配對一次；**每次重開機都要再按一次啟動** [S2]。shell 能做的事依版本和廠商不同 |
| **AppFunctions**（Android 16） | 呼叫別的 app 公開的功能 | 要 `EXECUTE_APP_FUNCTIONS` 加上**執行期允許清單**，一般側載的 app 宣告了也不保證能用 [F1]。現在不可行（與 [android-system-capabilities.md](android-system-capabilities.md) 的結論相同） |

## 對 pi-mobile 的建議

分級同 [t3-lody-paseo-design.md](t3-lody-paseo-design.md)：**A** 現在值得做；**B** 先做設計決定或實測；**C** 有明確需求再做；**D** 不做。

### A1. 固定規則：建立時寫成腳本，觸發時不叫模型

**借的是想法，不是程式。** IFTTT、Tasker、三星「模式與日常行程」的 Do 都是固定動作。pi 的 Do 一律是 agent run：每次觸發都要模型、要 token、可能判斷錯、沒網路就不能跑。

做法：`create_schedule` 多一種 Do：`script`。agent 建立自動化時，如果規則是固定的（「連上 Zhao → `sound` 設鈴聲 30%」），寫成一段 codemode 腳本存進排程；觸發時 runtime 直接在 QuickJS 裡跑它，只呼叫工具，不呼叫模型。腳本失敗才叫醒 agent（或發通知）。需要判斷的照舊是 agent run。

- 為什麼可行：工具已經是有型別的函式，codemode 的執行環境與工具橋接已在（`codemode.ts`）；`If` 已在原生端；`guards`／`only_if` 可以照樣擋在腳本前面。
- 要決定：腳本存在排程裡要讓使用者看得到（自動化那一列顯示「固定動作：鈴聲 30%」）；腳本只能呼叫工具，不能呼叫模型。
- 驗證：S24 上同一個「連上 Wi‑Fi 開鈴聲」各用 agent run 和腳本跑 10 次，比較 token、秒數、成功率；斷網時腳本仍要成功。

### A2. 市集加入 Home Assistant、IFTTT、Activepieces 的 MCP

pi 已能接有 OAuth 的 MCP，所以這是**加資料、照「新工具上線前」量測**，不是新功能。

- **Home Assistant**：使用者自己的網址，市集要能填網址（現在的市集是固定網址）；先確認它的 OAuth 是否接受 pi 的本機跳轉網址（`docs/tools.md` § MCP 服務市集的條件）。
- **IFTTT**：固定網址 `https://ifttt.com/mcp`；說明要寫清楚執行動作要 Pro。
- **Activepieces**：自架網址，同 Home Assistant；雲端版是固定網址。
- **Zapier**：已在市集；說明加上「每次成功呼叫扣 2 個 task」。

驗證：各自在 S24 上登入、`test/tool-cost.sh` 量工具定義、用一般說法問兩三題（例如「客廳燈關掉」「我的 IFTTT 有哪些 Applet」）。

### B1. 一個收外部事件的入口

整個生態（Huginn、Home Assistant、Node-RED、n8n、IFTTT 的 webhook 動作、GitHub）都會「事件發生時發一個 HTTP 請求」。pi 只要有一個入口，這些就全部變成 When。

- 選項（`triggers.md` 待決定第 3 題）：UnifiedPush（ntfy，不靠 Google，手機另裝 ntfy）、FCM（每個使用者要自己的 Firebase 專案）、或經使用者的電腦（`pi-mobile` 電腦端收 webhook，手機連著時轉送；手機不在時等下次連上）。
- 安全：webhook 的內容和通知一樣是不受信任的輸入，套用現有的 `guards`。
- 驗證：Huginn 或 Home Assistant 發一個事件，pi 在背景、螢幕關著時觸發排程。

### B2. Shizuku 作為無障礙之前的一層

符合「原生優先，無障礙是 fallback」：有 Shizuku 時，Wi‑Fi、藍牙、行動數據、飛航、定位、NFC、省電都能直接改，不用開面板、不用無障礙服務、不受畫面和語言影響。沒有 Shizuku 時照現在的做法。

- 要先實測：S24（Android 16、One UI 8.5）上每一項的 shell 指令是否有效；重開機後沒啟動 Shizuku 時，工具要能說清楚原因。
- 成本：Shizuku API 依賴、一個 `UserService`、設定頁一列狀態。

### C1. 呼叫使用者既有的 Tasker／Automate 自動化

已經用 Tasker 的人有大量現成的 task。`TaskerIntent` 依名稱執行（使用者授權後）、Automate 用 flow URI 開始。可以做成一個工具「執行 Tasker task」，或讓 Tasker 呼叫 pi（pi 當 Tasker 外掛，提供「問 pi」動作）。等有使用者真的用 Tasker 再做。

### C2. 讀 Automation（Jens）的程式碼當對照

它在 Android 上實際做到的觸發和動作清單，可以拿來檢查 pi 的「每類都能讀也能改」有沒有漏。GPL，只讀不抄。

### D1. 當 Tasker 外掛主機

Locale 外掛要先開外掛自己的設定畫面，由人填完回傳 Bundle 才能執行 [T1]；agent 沒辦法替使用者設定，每個外掛的 Bundle 格式也各自不同。

### D2. AppFunctions

要系統允許清單 [F1]。等 Android 開放第三方呼叫再看。

### D3. 把 n8n、Automatisch 列為推薦

n8n 不是開源授權 [N2]；Automatisch 社群版能否獨立運作有疑問。使用者想用仍可自己在 MCP 加入。

## 建議的順序

1. **A1 固定規則腳本**：直接解決「這種事系統內建的做得更好」的問題，也是 token 與可靠度最大的改進。
2. **A2 市集**：Home Assistant 優先（延伸到家裡的裝置），IFTTT、Activepieces 其次。
3. **B1 外部事件入口**：決定 `triggers.md` 第 3 題後再做。
4. **B2 Shizuku**：先在 S24 實測 shell 指令。

## 來源

- [I1] IFTTT Service API reference：triggers、queries、actions 的端點。https://ifttt.com/docs/api_reference
- [I2] IFTTT MCP。https://ifttt.com/mcp
- [I3] What is IFTTT MCP（方案限制）。https://ifttt.com/explore/what-is-ifttt-mcp
- [Z1] What is Zapier MCP。https://help.zapier.com/hc/en-us/articles/48308034391821-What-is-Zapier-MCP
- [Z2] How Zapier MCP usage works（每次呼叫 2 個 task）。https://help.zapier.com/hc/en-us/articles/45645738385805-How-Zapier-MCP-usage-works
- [A1] Activepieces MCP Server。https://www.activepieces.com/docs/mcp/overview ；MCP tools：https://www.activepieces.com/docs/mcp/tools
- [A2] Activepieces 授權。https://github.com/activepieces/activepieces/blob/main/docs/about/license.mdx ；pieces 目錄：https://www.activepieces.com/pieces
- [N1] n8n MCP Server Trigger。https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/
- [N2] n8n Sustainable Use License。https://github.com/n8n-io/n8n-docs/blob/main/docs/n8n-community-license/README.md
- [R1] Node-RED 授權：https://nodered.org/about/license/ ；Library：https://flows.nodered.org/?type=node
- [G1] Huginn README：https://github.com/huginn/huginn/blob/master/README.md ；WebhookAgent：https://github.com/huginn/huginn/blob/master/app/models/agents/webhook_agent.rb ；PostAgent：https://github.com/huginn/huginn/blob/master/app/models/agents/post_agent.rb
- [G2] Huginn v2026.10.14。https://github.com/huginn/huginn/releases/tag/v2026.10.14
- [H1] Home Assistant integrations。https://www.home-assistant.io/integrations/
- [H2] Home Assistant MCP Server。https://www.home-assistant.io/integrations/mcp_server
- [H3] Home Assistant Android。https://github.com/home-assistant/android
- [T1] Locale plugin API：https://github.com/twofortyfouram/android-plugin-api-for-locale ；Intent：https://twofortyfouram.github.io/android-plugin-api-for-locale/com/twofortyfouram/locale/api/Intent.html
- [T2] Tasker：Invoking Tasks Programatically。https://tasker.joaoapps.com/invoketasks.html
- [T3] Tasker 6.5 AI Generator。https://joaoapps.com/tasker-6-5-ai-generator-receive-shares-calendar-and-more/
- [T4] Tasker Intents。https://tasker.joaoapps.com/userguide/en/intents.html
- [T5] tasker-mcp（社群）。https://github.com/pmaxhogan/tasker-mcp
- [M1] Automate Flow beginning。https://llamalab.com/automate/doc/block/flow_beginning.html
- [D1] MacroDroid Webhook (URL) trigger。https://macrodroidforum.com/wiki/index.php/Trigger:Webhook_(URL)
- [J1] Automation（F-Droid）。https://f-droid.org/en/packages/com.jens.automation2/
- [X1] Termux:Tasker。https://github.com/termux/termux-tasker
- [S1] Shizuku API。https://github.com/RikkaApps/Shizuku-API/blob/master/README.md ；授權：https://github.com/RikkaApps/Shizuku
- [S2] Shizuku setup。https://shizuku.rikka.app/guide/setup/
- [F1] AppFunctionManager。https://developer.android.com/reference/android/app/appfunctions/AppFunctionManager
