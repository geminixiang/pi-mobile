# 架構


```
┌──────────────── 手機 (Capacitor WebView) ────────────────┐
│ React UI                                                  │
│ pi-durable harness ── IndexedDB（對話、執行狀態）           │
│   ├─ 模型、web_search ───── HTTPS ──▶ 模型供應商（pi-ai）   │
│   ├─ github_api、web_fetch ─ HTTPS ──▶ 網路                 │
│   ├─ code mode ──────────── Web Worker（QuickJS）           │
│   └─ coding tools ──── 手機上的 Bot 資料夾，或 WebSocket ─┐  │
│ AgentService（前景服務，背景執行）                          │  │
└────────────────────────────────────────────────────────────┼──┘
                                                 Tailscale │
┌──────────── 你的電腦（macOS、Linux）─────────────────────────┼──┐
│ pi-mobile serve：只聽 Tailscale 位址，只接受同一個使用者    ◀┘  │
│   ├─ 直接：pi-env serve，以你的帳號、從家目錄                    │
│   └─ 容器：docker exec ─▶ pim-main：pi-env serve，/workspace/<bot>│
│              bridge.py ◀── pi-mobile-egress（mitmproxy）          │
│              只攔 GitHub、Google、Cloudflare、Azure，               │
│              向手機要 token                                       │
└───────────────────────────────────────────────────────────────────┘
```

**為什麼 agent 跑在手機上？** 對話和金鑰都只在手機上，不需要一直開著的伺服器，換 sandbox 主機也不影響對話紀錄。

**為什麼用 Capacitor？** WebView 是 pi-ai 正式支援的瀏覽器環境，串流和 WASM 都能直接用。

### 電腦

pi-env 的 `Connection` 只會用 `spawn` 啟動子行程，WebView 做不到。手機直接用 pi-env 的 `Connection` 和 `RemoteExecutionEnv`（2026-10-26 起，取代原本的移植版 `StreamConnection`）：`node:child_process` 換成 `src/shims/node-child-process.ts`，它的 `spawn` 交給 `src/agent/sandbox/phone-connection.ts` 開 WebSocket，回傳一個像子行程的物件。那個物件只把完整的 frame 交給 pi-env；連線斷掉、電腦還保留著 daemon 時，它每 5 秒替 daemon 送一個 ping，pi-env 才不會在 30 秒沒收到東西時把連線拆掉。連線看似正常卻 20 秒沒有任何訊息時（daemon 每 5 秒會 ping），由 `ResumableSocket` 主動重接。`PhoneConnection`（`Connection` 的子類別）只多做兩件事：驗證 hello（不對就結束這條連線），以及在連線中斷的錯誤上寫明請求是「送出前就斷了」還是「已送出、結果不明」。pi-env 的 `Connection` 會對 `setInterval` 的回傳值呼叫 `unref()`，WebView 的計時器沒有這個方法，`vite-plugins/pi-env.ts` 在打包時拿掉那一行，`test/pi-env-patches.ts` 確認 pi-env 升級後那一行還在。

**把電腦交給 pi**（設定 › 電腦）：
- 電腦上執行一次 `host/install.sh`，裝好常駐的 `pi-mobile serve`（`host/main.go`）。
- 它只聽這台電腦的 Tailscale 位址，用 `tailscale whois` 確認來的是同一個 Tailscale 使用者的另一台裝置，再比對配對時發的金鑰；不用 SSH。見 [design/computer-host.md](design/computer-host.md)。
- 手機只要輸入電腦名稱。第一次連線時，手機把對應平台的 pi-env 上傳過去。

每個 Bot 在面板裡選一台電腦，以及它在那裡的工作方式：
- **直接**：從家目錄直接操作這台電腦，不另開資料夾；刪 Bot 不會刪電腦上的檔案。
- **容器**：電腦上有 docker、podman 或 nerdctl 時才有。手機透過 電腦上的 pi-mobile 的 `/exec` 驅動容器引擎：建好 image，所有 Bot 共用 `pim-main`，各自一個資料夾。egress proxy 透過另一條 `/exec` 通道上的 `bridge.py` 向手機要 token，所以憑證只在手機上。

沒選過電腦的 Bot 跟著設定 › 電腦的預設，預設是手機；配對電腦不會改預設，要在設定裡自己選。配對後自動改成電腦的直接模式時，新 Bot 一建好就能在電腦帳號下讀寫整個家目錄（2026-10-29 測 qwen3.6 時，它在家目錄寫檔、跑 `find /`、grep 整個家目錄）。選過的電腦後來從設定移除（或那台電腦不再有容器），Bot 不會改到別台電腦或手機：它沒有執行環境，`read`、`write`、`edit`、`bash` 回錯誤，提示裡也告訴模型原因，其他工具照常；面板顯示「已移除的電腦」（就算一台電腦都不剩也會顯示選單），直到重新選一台。不同電腦的權限範圍不同，原本在容器裡的指令不能默默改在電腦帳號下執行。

設計見 [design/computer-host.md](design/computer-host.md)。

### 憑證與 egress proxy

每個 sandbox 的 HTTP(S) 流量都經過 `pi-egress`（mitmproxy + `sandbox/egress/credentials.py`）。它只攔下表裡的主機，其他網站（pip、npm、apt）直接放行、不解密。Proxy 的 CA 在容器第一次連線時裝進去。

| | GitHub | Google Cloud | Cloudflare | Azure |
|---|---|---|---|---|
| 攔截的主機 | `github.com`、`api.github.com`、`uploads.github.com`、`raw.githubusercontent.com` | `*.googleapis.com` | `api.cloudflare.com` | `management.azure.com`、`graph.microsoft.com`、`*.vault.azure.net`、Storage |
| 容器裡的佔位 | `GH_TOKEN` | `gcloud` 的 `auth/access_token_file` | `CLOUDFLARE_API_TOKEN`（`cf`、`wrangler` 都用它） | `az login --identity`：bridge 扮演 managed identity 端點，發格式正確、沒有效力的 JWT |
| 登入方式 | 貼 fine-grained token | App 內 Google 登入，或貼 service account 金鑰 | App 內 Cloudflare 登入（`cf` 的 device flow），或貼 API token | App 內 Microsoft device code（az 的公開 client），代碼自動複製 |
| 真的憑證在哪 | 手機 Keystore；proxy 每次需要時透過 bridge 向手機要，不留在電腦上 | 長期憑證**只在手機上**；proxy 需要時請手機換一個短效 access token | 同 Google Cloud；refresh token 每次換新都會寫回 Keystore | 同 Cloudflare；每個 Azure 資源（ARM、Graph、Key Vault、Storage）各換一個 token |

Sandbox 裡設了 `NODE_USE_ENV_PROXY=1`：Node 26 內建的 `fetch` 預設不走 `HTTPS_PROXY`，不設的話 `cf` 這類工具會繞過 proxy。

讀取和寫入都直接帶上憑證，不會先問。手機沒連上時，GitHub 的請求不帶憑證送出，其他服務回 `pi mobile: 手機沒有連上…`。

**登入用的 OAuth client**：Google、Cloudflare、Azure 的 app 內登入，借用的是各家官方 CLI 公開發布的 client（`gcloud auth application-default login`、`cf auth login`、`az login` 用的同一組），所以同意頁上顯示的是那些 CLI 的名稱。這讓你不用自己去各家註冊 OAuth app；代價是哪天供應商限制這些 client，登入就可能失效。

## 程式碼看不出來的原因

程式碼不寫註解（見 AGENTS.md）；唯一的例外是一兩行的 `// why: …`，寫程式表達不出、讀的人也猜不到的限制。超過一兩行、或牽涉幾個檔案的外部原因，記在這裡。

**儲存**
- 對話存在 WebView 的 IndexedDB。2026-10-22 在模擬器量過 SQLite（`@capacitor-community/sqlite`）：啟動要 73 次 bridge 呼叫，約 2 秒（2.1–6.2 秒）才看到對話；IndexedDB 是 0.6 秒。
- `IndexedDbStorage` 只能有一個擁有者，所以用 Web Lock 擋住第二個 WebView（數位助理以前會開一個）。reload 時舊頁面走了才放鎖，新頁面最多等 5 秒。

**診斷**
- `src/log.ts` 除了寫 console，還留最近 2000 行在記憶體（含時間、已遮蔽 token 樣式的字串），設定頁最下面「分享診斷記錄」把它存成 `.jsonl` 走分享表。正式版關閉 WebView 偵錯，這是正式版唯一拿得到 JS 端證據的路。主執行緒每 250 ms 心跳一次，前景時間隔超過 500 ms 記一筆 `ui.stall`；頁面在背景被 Chromium 凍結的那一段不算。

**Runtime 的生命週期**
- 改設定先問 `AgentRuntime.apply(next)`。runtime 邊跑邊讀的設定（預設模型、思考程度、壓縮門檻、電腦清單、配對金鑰、預設電腦）就地生效：沒變的電腦連線留著，進行中的回合不受影響；壓縮門檻換掉的是 harness 每次請求時讀的 `models`。其他設定（供應商與金鑰、雲端憑證、GitHub token、行事曆範圍）在開 harness 時就裝進了 extension，`apply` 回 `needs_restart`，`App.tsx` 才關掉整個 `AgentRuntime` 再開一個新的；這會停下正在跑的工作（2026-10-26 在 S24 重現：改壓縮門檻時容器裡的指令回 `Tool bash was interrupted`）。`close()` 先關 harness，再關 MCP 和電腦連線；前一步失敗也照樣關後面的。
- MCP 的每條連線有一個 generation：重新連線、登出、關閉都會讓它加一，舊的連線不管在哪一步完成，都只關掉自己，不改狀態、不安裝工具。關閉後的連線不會再被 `refresh` 或登入的回呼打開。新增和移除服務排成一列；移除中的服務已經不在清單上，不能再開給 Bot。
- 刪除 Bot 先在 `BotIndex` 標成刪除中（清單上不再出現，不再收輸入，排程也不會再送），再停下它的工作、清資料夾和附件，全部清完才把它從 `BotIndex` 拿掉並刪掉記憶。電腦連不上、容器資料夾沒刪掉，或刪到一半 app 被關掉，下次打開時接著做。pi-durable 不能刪除一條對話，所以對話紀錄留在 IndexedDB。
- Code mode 的 QuickJS Worker 和手機資料夾的 bash Worker 跟著 app，不跟著 runtime，一個 app 各一個：它們不帶 runtime 的狀態，跟著 runtime 開關的話，每改一次設定就多留一個 Worker。

**不做背景任務（2026-10-24 的決定）**
- 評估過兩種：pi-durable example 22 的 subagent（助手是另一條對話，另一個模型在想）和 example 23 的 child task（純程式的 durable task，沒有模型）。前者做完了、也在模擬器上跑過（分支 `helpers`，含 `docs/design/helpers.md` 和 contracts），後者寫了 demo（example 23 的骨架換成四條真的 shell 指令）。
- 都不上：手機上的工作是幾秒到半分鐘一件，code mode 一輪裡 `Promise.all` 已經是「一次做很多事」，排程已經是「晚點做、做完叫我」。subagent 對十秒的任務是純協調成本（三件事 300 秒、多一份上下文、還錯一題），只在要跑幾分鐘、要反覆試的電腦任務上划算；child task 要配一整套卡片、取消、中斷標記的 UI，換到的只有「幾分鐘以上的指令不卡回合」。
- 哪天要回來做：subagent 從 `helpers` 分支撿，先加門檻（只派幾分鐘以上、不需要你參與的事）、做成預設關的工具組、處理兩個助手搶螢幕；child task 照 demo 的形狀，把報告以 follow-up 送回對話。

**背景執行（Android）**
- WebView 的 JavaScript 跑在 Chromium 的 renderer 程序，不在前景服務保護的 app 程序裡。WebView 看不見時 Chromium 會降低 renderer 的重要性，所以 `KeepAlivePlugin` 在 agent 工作時把它拉高。
- Blink 會凍結隱藏超過一分鐘的頁面（計時器、plugin callback 都停），`PiWebView` 讓它在背景時仍算可見。
- Samsung 會讓 app 睡著，所以設定裡可以申請不受電池最佳化限制。
- Android 14 起精確鬧鐘預設關閉，排程要使用者在系統設定裡打開才會準時；沒打開時會晚幾分鐘。
- 鬧鐘觸發後的短暫豁免期內才能啟動前景服務，所以 `TriggerReceiver` 一收到就先啟動服務。
- 返回鍵用 `@capacitor/app` 的 backButton 事件，不用瀏覽器 history：Chromium 會跳過頁面自己推的 history。

**效能（S24，`test/device/jank.sh`；2026-10 起用 `test/perf/run.ts`，見 development.md）**
- 對話的每一則訊息都 memo：Chat 每個按鍵、每個串流 token 都會重繪，全部重算 Markdown 時打字每鍵要 30–40 ms。
- `EntryView` 的 memo 只比對這則訊息自己的工具呼叫狀態，不比對整個 `calls`：送出和回答完成時對話紀錄會變，`calls` 每次都是新的 Map，原本會讓每一則訊息重新解析 Markdown，一次約 230 ms。
- 串流中只解析正在寫的段落（以程式碼區塊外的空行切開），已完成的段落 memo；每幀全文解析會掉 3% 的幀。文字一陣一陣到（約 150 ms 一批），`useSmoothText` 每幀補一點，在一批的間隔內追上。串流的字不做淡入：每個字一個 `<span>` 加 opacity 動畫，在 120 Hz 下串流時有 61% 的幀超時，拿掉後 9%。
- 頂欄、輸入框、佇列和「最新」按鈕都是實色，不用 `backdrop-filter`：底下的文字每動一幀，模糊就要在 GPU 上重算一次。串流中來回捲，超時的幀 19% → 12%。
- Mermaid 圖：inline SVG、SVG `<img>`、畫一次的 PNG 都只掉 0–2 幀（每次約 260 幀），跟藏起來一樣，所以用最簡單的 inline。
- Mermaid 用 pele 畫（beautiful-mermaid 的 chunk 是它的兩倍）：它照容器寬度排版（`maxWidth`），橫的流程圖改成直的、圖表縮到螢幕寬，字不會變小，所以要掛上去量到寬度才畫。它跟 Mermaid 一樣嚴格，中文標籤沒加引號的 xychart 會畫不出來，系統提示要模型加引號。

**外部服務**
- 現在時間不放系統提示：pi-durable 每次請求都重算區段，變了就把整段再送一次，放分鐘會每一輪重送 preamble。`assistant.ts` 的 `beforeRequest` 在送出前，給每一則使用者訊息加上它自己的送出時間（只在這次請求，對話紀錄不變）；時間取自訊息的 timestamp，舊訊息每次都一樣，快取照常命中。模型不用再先呼叫 `device_info` 讀時間。
- pi-durable 在請求超過 contextWindow 減掉保留量（預設 16k）時壓縮。把使用者的門檻加上保留量回報成 window，就會在門檻壓縮，而不是接近模型上限才壓。
- Cloudflare 每次 refresh 都換新的 refresh token、作廢舊的，Microsoft 有時也會；新的要在下一次 refresh 之前寫回 Keystore。
- Google 的 installed-app client secret 是公開的（寫在每一份 Cloud SDK 裡），不是秘密。
- Nominatim 的使用規範要求 app 表明身分；WebView 不能設 User-Agent，所以走原生 HTTP。
- 原生 HTTP 不受 WebView 的 CORS 限制：沒有 CORS 標頭的 API（ChatGPT 登入後的 OpenAI）走 `StreamFetchPlugin`，因為 CapacitorHttp 會把串流回應整個收完才交出來。
- 通話紀錄和簡訊的權限 Google Play 只給預設電話和簡訊 app；pi 是自己安裝的，在這裡是一般的執行時權限。

**電腦（macOS）**
- `screencapture` 取圖（macOS 15 起 CoreGraphics 的擷取已移除），Quartz 事件送滑鼠和鍵盤。
- 控制其他 app 時 macOS 每個 app 各問一次權限，沒辦法事先問完；安裝時只問最常用的 System Events。

## 專案結構

這裡只列從哪裡找起。

| 路徑 | 內容 |
|---|---|
| `src/agent/runtime.ts` | `AgentRuntime`：開啟 harness 並接好各部分；Bot 清單、對話控制器、每個 Bot 的電腦、工具組和記憶 |
| `src/agent/available-models.ts` | 這支手機能用哪些模型：各供應商的模型清單、金鑰、web 搜尋用哪一家 |
| `src/agent/assistant.ts` | 每個 Bot 共用的開頭提示 |
| `src/agent/catalog.ts` | 內建工具的唯一清單；工具的寫法見 [tools.md](tools.md) § 介面規範 |
| `src/agent/tools/` | 內建工具，一個領域一個檔案；`common.ts` 是共用的 `defineAppTool` |
| `src/agent/codemode.ts`、`on-demand.ts`、`toolsets.ts` | Code mode（QuickJS Web Worker）、需要時才載入的工具、Bot 可選的工具組 |
| `src/agent/bots.ts`、`memory.ts`、`triggers.ts`、`skills.ts` | Bot 的資料與系統提示、MEMORY.md、排程（定義、工具，和 `TriggerRuns`：同步到原生鬧鐘、觸發時的次數上限）、技能 |
| `src/agent/providers.ts`、`models.ts`、`credentials.ts`、`chatgpt.ts` | 模型供應商、自訂端點、金鑰、ChatGPT 登入 |
| `src/agent/mcp.ts`、`mcp-catalog.ts` | MCP 服務（含 OAuth）與服務市集 |
| `src/agent/gcloud.ts`、`cloudflare.ts`、`azure.ts`、`oauth.ts`、`clouds.ts` | 三家雲端的登入與憑證；`clouds.ts` 把設定裡的憑證變成工具和容器用的 token |
| `src/agent/attachments*.ts` | 附件：PDF、Word、試算表、圖片 |
| `src/agent/files/` | 沒有電腦時，Bot 在手機上的資料夾和 bash（just-bash Web Worker） |
| `src/agent/workplaces.ts`、`src/agent/sandbox/` | `Workplaces.at(bot)` 回答一個 Bot 在哪裡工作（手機、電腦直接或容器、已移除的電腦），帶著它的執行環境；pi-env 的 frame 協定、檔案與 git |
| `src/agent/platform.ts` | `AgentRuntime` 向手機要的東西：localStorage、Keystore、MCP client、手機資料夾、模型清單。App 給 Capacitor 的實作，`test/contracts/` 給記憶體的 |
| `src/agent/parse.ts` | 邊界驗證（typebox） |
| `src/browser/` | Bot 的瀏覽器：外掛合約、注入網頁的 `page.ts`、`read_page` 和 `use_browser` 工具、瀏覽器面板。程式碼依功能分資料夾，其他功能整理時也會搬成這樣 |
| `src/phone-screen/` | 手機畫面：外掛合約、`read_phone_screen` 和 `use_phone_screen` 工具。設定頁的開關還在 `Settings.tsx`，跟其他設定區塊放在一起 |
| `src/idb.ts`、`src/settings.ts`、`src/app/storage.ts` | 其他 IndexedDB 資料、設定（密鑰在 Keystore）、App 開啟 pi-durable 的 IndexedDB 儲存。`src/` 根目錄只放 UI 和 agent 都用的模組，只有一邊用的放在 `src/app/` 或 `src/agent/` |
| `src/plugins/` | 原生 plugin 的 contract（方法、參數、回傳和事件的 schema），各自對應 `android/.../<名稱>Plugin.java` 和 `ios/App/App/<名稱>Plugin.swift`；`define.ts` 在邊界驗證回傳，`test/plugins-node.ts` 對照兩個平台的實作 |
| `src/shims/` | 讓 pi-env 的 Node import 能在瀏覽器打包 |
| `src/app/` | React UI |
| `android/app/src/main/java/dev/geminixiang/pimobile/` | 原生功能：前景服務、plugin、排程、通知、數位助理 |
| `host/` | 電腦上的 `pi-mobile`（Go）：`serve`、`mcp computer`，與安裝腳本 |
| `sandbox/` | 容器的 image 和 egress proxy（app 透過電腦上的 pi-mobile 建置） |
| `scripts/` | Android 建置（開發版、發布版）與安裝、圖示產生 |
| `test/` | 工具和 plugin 介面的檢查、單元測試；`contracts/` 用假的模型和記憶體的 `Platform` 開一個真的 `AgentRuntime`，驗生命週期的約定；`device/` 在手機上操作和量測 app（`ui.sh` 經 CDP 或 WebKit 執行頁面函式、`tool-cost.sh`、`jank.sh`）；`perf/` 是 S24 的效能量測 |
