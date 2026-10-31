# Mika 與 pi mobile

調查日期：2026-10-30。對象：[wangzan101/mika](https://github.com/wangzan101/mika) 0.1.3（commit `cb59b80`）。問題：同樣是「手機上的 agent」，Mika 怎麼做、哪些做法值得 pi mobile 借。

結論先講：

- 兩者幾乎互補。**pi mobile 是「廣」**：手機原生 API、自動化事件、電腦／雲端／MCP、Android 和 iOS。**Mika 是「深」**：只做一件事——像人一樣在背景操作任何 App 和網站——但做得很深，包括虛擬螢幕、OCR 補洞、動作效果核對、跨 App 跳轉、接管、防風控。
- Mika 的核心是**背景虛擬螢幕**：App 自己實作 ADB 無線配對，拉起一個 shell 權限的 helper 來建螢幕、注入輸入，使用者照常用手機。pi mobile 的 `use_phone_screen` 只能操作使用者自己的主螢幕。
- 便宜又直接的可借之處：給 `use_phone_screen` 每步加等待條件、每個動作回報實際效果並讀回打的字、無障礙樹不夠用時用 OCR 補讀、主迴圈快照測試。
- 虛擬螢幕加 shell helper 的效益最大，成本也最高（光 ADB 協定約 1,000 行，helper 加主螢幕監看又是好幾千行，13 起才能用、14 起才不搶焦點），等於另一個大專案。
- Mika 的「擬人化」節奏是為了躲網站的機器人偵測，README 自己承認有被封號的風險；要借只取「限速」的概念。

## 1. Mika 是什麼

Android 原生 App（Kotlin + Compose），使用者自己帶模型 API Key，沒有後端伺服器。agent 在一塊看不見的虛擬螢幕上操作任何 App，另外內建一個桌面版瀏覽器和一個 Linux 沙箱（PRoot + Alpine）。

- 規模：13.3 萬行 Kotlin，其中單元測試約 4.6 萬行、裝置測試約 1.2 萬行。
- 只有 19 個 commit：0.1.0 是一次整包發出來的，看不到開發歷程。
- 授權 Apache-2.0，可以借用程式碼，要附上 NOTICE。沙箱裡的 PRoot 是 GPL，以子行程方式執行。
- 公開 beta，作者自述主要只在一台 Android 14 手機上測過。
- `docs/architecture.md` 有 265 行，按程式碼現狀寫，帶類名和路徑，是讀懂它最快的入口。

### 分層

- `:core`：純 JVM，不依賴 Android。主迴圈、工具、上下文、記憶、知識、觸發器都在這層，能在電腦上用假模型測。各能力（phone / web / sandbox）之間互不引用，由 `PackageDependencyTest` 把關。
- `:app`：Android 宿主，負責 UI、前景服務、虛擬螢幕、無障礙、WebView、沙箱。
- 執行路徑：`TaskService → TaskCenter`（每個對話一個 Run，可並行、可排隊）`→ TaskRun → AgentLoop`（只做調度）`→ ToolDispatcher → ActionExecutor`（改變外部世界的唯一入口，`ActionPass` 的建構子是 internal，從編譯層擋住繞過）。

## 2. 最有價值的六個技術

### 2.1 在 App 內自己實作 ADB，取得 shell 權限

`core/adb/`，約 1,000 行。

- 自己寫了無線偵錯配對（SPAKE2、Ed25519、TLS）。配對碼由無障礙服務從設定頁自動讀出，不需要電腦。
- 連上本機 adbd 後，用 `app_process` 以 shell 身分啟動 helper 行程（`app/cap/phone/shell/HelperProcess.kt`）。啟動參數帶 Mika 的 uid 和簽章指紋，再從 stdin 傳一次性口令，防止別的 App 冒用。
- helper 負責：建立虛擬螢幕（`ShellService` 裡的 `createVirtualDisplay`）、在那塊螢幕上啟動 App、注入按鍵與逐點手勢、靜音目標 App、改系統設定。
- 系統關掉無線偵錯時（換 Wi-Fi、重開機），它自己寫 `adb_wifi_enabled=1` 再打開，並偵測「這個 Wi-Fi 還沒被允許」，避免一直彈框。無障礙服務被系統停掉時也會自己重開。
- 用 `ITaskStackListener` 監看主螢幕：被操作的 App 從背景把另一個 App 開到使用者螢幕上時，把那個任務挪回虛擬螢幕。系統問「用哪個 App 開」時不挪，停下讓使用者選。

### 2.2 WebView 用 DevTools 協定（CDP）驅動

- 直接連自己行程的 `webview_devtools_remote_<pid>` abstract socket（`app/cap/web/cdp/DevtoolsTransport.kt`）；被拒時改由 shell helper 代連。
- 點擊和輸入都是真實的輸入事件。WebView 畫在 App 自建的私有虛擬螢幕上，不需要 helper。
- 刻意**不開** `Runtime.enable`，因為網站偵測得到有偵錯器掛著（作者說真機上有網站因此一直重載）。讀頁面的腳本跑在隔離環境、唯讀、禁止連網。
- 使用者可以在側欄「瀏覽器」自己登入，Cookie 和 Agent 共用。

### 2.3 讀畫面：無障礙樹 + OCR 補洞

- `TreeQuality` 先判斷無障礙樹夠不夠用（有名字的元素夠多、沒有一大塊沒字的區域），不夠才用 APK 內建的 ML Kit OCR 補讀樹裡沒有的字，每行帶 0–999 的座標。
- 每個動作都回報實際效果（`ActionEffect`）：有沒有變化、打的字讀回來對不對。點了看不出變化而樹又讀不到那一處時標 `treeBlind`，提示改說「看不出變化不等於沒點上」。
- 動作後畫面上新出現「次數已用完」「操作過於頻繁」這類字時，結果帶 `limitReached`，批次停在這一步。

### 2.4 主迴圈

- **沒有 `done` 工具**：模型不帶工具呼叫的回覆就是答案；做不成就呼叫 `end_not_done`，subtype 是 `blocked`、`login_incomplete`、`captcha_incomplete`、`route_failed`、`device_unavailable`、`interaction_failed` 之一。
- **回答的「來源」由系統產生**：從證據帳本挑出最多 6 條，不讓模型自己寫。
- **`do_steps` 一次 1–20 步**：每步可帶 `expect` / `expect_gone` / `expect_app` / `wait_stable` 條件，由程式讀畫面等待（預設 8 秒、最多 20 秒），不必為了「還在載入」再問模型一次。
- **工具分組、用到才展開**：一開始只給入口工具（`phone_launch_app`、`web_navigate`、`run_command`），呼叫後才展開整組定義和那段能力說明。順序固定，所以前綴快取最多失效一次。
- **插話**：撤掉正在等的模型請求，接在歷史後面重問；已經在執行的工具照常做完；跑完還沒處理的插話變成下一件任務。
- **停止後**：用輕量模型寫幾行交代（做了什麼、送出了幾次、哪些沒做完，12 秒內），所以下次說「繼續」它知道從哪接著做。
- **上下文分四區**：系統提示＋工具、開場上下文、只追加的歷史、本步狀態。估算用量超過上下文的 0.6 才一次性壓縮，壓縮不呼叫模型（先縮舊結果，再折疊舊回合）；使用者原話永遠不裁。
- **意圖判斷**：對話發起的任務第一次要用非查閱工具時，用輕量模型判斷使用者是在聊天、查資訊還是要辦事。

### 2.5 安全模型

- 預設「詢問」模式只攔花錢的那一步。送訊息、刪除、改設定都直接做。
- 同意只放行緊接著的那一個操作（`ConfirmationGate`：同一 App、同類動作、金額在螢幕上、3 步之內、中間沒做別的寫入）。付款本身一律交給使用者親手完成。
- 沒人在場的任務（定時任務、子任務）遇到要花錢的一步，直接拒絕，不等人。
- 「自主」模式連付款也不問。

### 2.6 工程習慣

- **提示詞金樣測試**（`core/src/test/resources/prompt-surface/`）：鎖住系統提示詞和每個工具說明的全文與大小。
- **主迴圈快照測試**（`loop-snapshots/`）：用假模型跑完整劇本，逐請求記下送了什麼（系統提示的長度與雜湊、工具清單、哪幾則訊息沒變）。
- **評測題集**（`eval/tasks/`）：約 150 題，分 tune / holdout 池，保留池只在發版時看，被拿來調過就挪進調優池。查資訊題用 `answer_grounded` 檢查回答裡的數值真的讀過。
- **App／網站知識**：每份一個 `APP.md` / `SITE.md`（目前 18 個 App、12 個網站），只寫事實不寫規定，開局或進入該 App 時自動補給模型。

## 3. 要注意的地方

- **擬人化節奏是用來躲網站的機器人偵測**：點擊落點隨機偏移、滑動走弧線、同站連續換頁停 4–16 秒、兩次對外動作隔 8–20 秒、等待時隨機捲幾下、不開 `Runtime.enable`。README 有免責聲明，承認有被封號的風險。
- **自學與回放實際上沒有在運作**：最終核查被關掉了（`TaskRun` 裡 `reviewFinalAnswer = false`），而技能自學、路線回放都要求「核實過」，所以這些在產品裡目前不會發生。
- **自主模式有個漏洞**：`ConfirmDecision.judge` 裡自主的提前返回排在「不對 Mika 自己動手」（`ownApp`）檢查之前，所以開自主模式時這層保護失效。作者知道，決定暫不修。
- **唯讀 JS 有幾個繞過點**：CSS 跳脫寫法的 value 選擇器、`valueAsNumber` 等屬性讀密碼框、fetch 標頭全放行。roadmap 列為待辦。
- **MCP 只有骨架**，沒有傳輸層，使用者用不到。
- **程式碼風格和 pi mobile 相反**：到處是中文 KDoc 和行內註解。

## 4. 全面比較

| 面向 | 項目 | pi mobile | Mika |
|---|---|---|---|
| **定位** | 一句話 | 隨身帶著走的 AI agent：手機助理，同時是遙控電腦、容器與雲端的入口 | 替你操作手機 App 和網站，把事辦成 |
| | 主要場景 | 手機資料與狀態、自動化觸發、寫程式／開發維運（電腦、GitHub、雲端）、MCP 服務 | 在中國的 App 裡辦事：微信、小紅書、美團、BOSS 直聘等；查價、發訊息、下單 |
| | 主要市場／語言 | 台灣；介面繁中，提示詞英文 | 中國；介面簡中，提示詞英文 |
| | 版本與成熟度 | 0.11.3，446 個 commit，有 S24 與 iPhone 的實機流程 | 0.1.3 公開 beta，19 個 commit（0.1.0 一次整包發出），主要只在一台 Android 14 手機上測過 |
| | 授權 | 自用 | Apache-2.0；PRoot 是 GPL，以子行程方式執行 |
| **技術棧** | 外殼 | Capacitor + React，跑在 WebView 裡 | 原生 Kotlin + Jetpack Compose |
| | Agent 核心 | 外部套件 `@earendil-works/pi-durable`、`pi-ai`、`pi-env`、`pi-mcp` 1.4.0 | 全部自己寫（`:core` 是純 JVM 模組） |
| | 程式量 | TS 約 1.9 萬行、Android 原生約 6.7 千行、iOS Swift 約 4 千行 | Kotlin 約 13.3 萬行（含測試約 5.8 萬行） |
| | 平台 | Android + iOS（TestFlight） | 只有 Android |
| | 最低版本 | minSdk 36（Android 16） | 安裝要 Android 11；執行任務要 13；建議 14 以上 |
| | 對話儲存 | IndexedDB，pi-durable 管理 | JSON 檔，原子替換寫入 |
| **Agent 迴圈** | 結束條件 | pi-durable 的標準回合 | 沒有 `done` 工具；做不成時呼叫 `end_not_done`，帶固定幾種 subtype |
| | 插話 | 「插話」接在下一輪工具之後；「稍後」等這次跑完；排隊的訊息可撤回 | 撤掉正在等的模型請求並重問；正在等待的工具提前結束；跑完還沒處理的插話變成下一件任務 |
| | 停止後 | 排隊的訊息放回輸入框 | 用輕量模型寫幾行交代，下次說「繼續」知道從哪接著做 |
| | 中斷後恢復 | `harness.resume()` 接著跑完中斷的 run | 從不從中間續跑（畫面狀態回不去），只告知「已中斷」，由使用者重新發起 |
| | 並行 | 每個 Bot 一條對話；子 agent 和背景任務評估過、決定不做 | 不同對話可並行（每任務一塊虛擬螢幕，上限 1–3，預設關）；有 `spawn_agent` 唯讀子任務 |
| | 步數上限 | 依 pi-durable | 正式任務不設；評測和子任務才有（子任務 15 步） |
| | 判斷要不要動手 | 靠提示詞 | `IntentGate`：輕量模型判斷是聊天、查資訊還是辦事 |
| | 卡住偵測 | 由守衛（`guards.ts`）處理 | `StopRules`：重複同一動作、沒進展、沙箱打轉時叫停；`StuckAdvice` 在結果裡附建議 |
| **上下文** | 壓縮 | pi-durable 摘要；門檻可選 64k／128k／256k／512k，也可手動 | 不呼叫模型：先縮舊結果再折疊舊回合；到上下文的 0.6 才壓；使用者原話永遠不裁 |
| | 快取設計 | 依 pi-durable | 明確分四區；一個任務內前綴只會因展開工具組失效 |
| | 不可信內容 | 觸發器的防線與 classifier（`judge.ts`） | 網頁等內容包進 `<untrusted>`，參考資料包進 `<context trust=…>` |
| **工具的提供方式** | 數量 | 約 50 個工具＋ MCP | 約 68 個工具說明檔 |
| | 按需載入 | 三層：直接給、`tool_search` 載入、只給腳本（code mode） | 分組展開：一開始只給入口工具，呼叫後才展開整組 |
| | 批次執行 | code mode：QuickJS 腳本一次呼叫多個工具（`Promise.all`） | `do_steps`：一次 1–20 步，每步可帶等待條件；`phone_run` 是條件式命令串 |
| | 介面守門 | `tools.snapshot.json` 加 `npm run check` | 工具屬性宣告（風險、能不能批次等）加提示詞金樣測試 |
| **操作手機畫面** | 方式 | 無障礙服務操作**使用者自己的主螢幕**（`read_phone_screen` / `use_phone_screen`，要時才載入） | **背景虛擬螢幕**：自建 ADB 配對，拉起 shell helper 建螢幕、注入輸入；使用者照常用手機 |
| | 需要的設定 | 開無障礙 | 開無障礙，加無線偵錯配對一次；之後自動重開無線偵錯、自動修好無障礙 |
| | 讀畫面 | 元件（角色、文字、中心座標），要時加截圖 | 無障礙樹 + ML Kit OCR 補洞，要時加截圖；看圖定位模型 |
| | 動作回報 | 做完回傳畫面 | 每個動作回報實際效果；打的字讀回核對；偵測「到上限了」 |
| | 跨 App 跳轉 | — | 監看主螢幕，把被開到使用者螢幕的 App 挪回虛擬螢幕；系統選擇器停下讓使用者選 |
| | 接管 | — | 把 App 挪到主螢幕讓使用者處理（登入、驗證碼、付款），處理完挪回去 |
| | 擬人化節奏 | 無 | 點擊落點隨機偏移、弧線滑動、兩次對外動作隔 8–20 秒 |
| **手機原生能力** | 狀態與感測器 | 電量、網路、定位、感測器、Health Connect、螢幕使用時間 | 無（全靠操作 App） |
| | 個人資料 | 聯絡人、照片、通話紀錄、簡訊、日曆讀寫、通知讀取／回覆／清除 | 無 |
| | 手機控制 | 勿擾、音量、亮度、手電筒、媒體、連線面板 | 用 `phone_system_command` 透過 shell 下指令 |
| | App intent | 鬧鐘、計時器、郵件、簡訊、地圖、分享、開連結 | `phone_share_text`、`phone_open_link` |
| | 語音 | 語音輸入；`speak` 從耳機唸出來 | 無 |
| **網頁** | 讀網頁 | `web_fetch`，需要 JS 時在看不見的 WebView 渲染；`web_search` 用模型供應商的搜尋 | 內建完整瀏覽器：CDP 真實輸入、預設桌面版、每任務最多 4 個分頁、上傳下載、`web_capture`、唯讀 JS |
| | 登入狀態 | — | Cookie 和 Agent 共用；使用者可自己登入；網頁接管 |
| | 防風控 | — | 同站換頁停 4–16 秒、每站頁數上限、辨識風控攔截頁 |
| **執行環境** | 手機上 | just-bash + 原生資料夾；QuickJS 跑 code mode | PRoot + Alpine 3.22（真的 Python、Node、shell），只支援 arm64，預設斷網 |
| | 遠端 | Tailscale 連電腦的 `pi-mobile serve`，直接或容器；可操作電腦畫面（`use_screen`） | 無（roadmap 列「以後」） |
| | 從沙箱回呼 | — | 沙箱裡用 `mika phone …` 呼叫手機工具 |
| **外部服務** | 雲端與開發 | GitHub、GCP、Cloudflare、Azure；憑證只在手機，egress proxy 每次需要時向手機要 | 無 |
| | MCP | 精選服務目錄、OAuth、逐 Bot 授權 | 只有骨架，沒有傳輸層 |
| | 其他資料 | 台股、天氣、地點（OSM）、SQLite 資料庫 | 無（全靠操作 App 或網頁） |
| **模型** | 供應商 | pi-ai 目錄；自訂端點；Sign in with ChatGPT | DeepSeek、通義千問、Kimi、智譜、OpenRouter、Anthropic、Gemini 預設；相容 OpenAI／Anthropic／Gemini 的端點 |
| | 角色分工 | 一個預設模型＋思考程度；觸發器用 classifier | 主模型、看圖模型、輕量模型；可把簡單步驟交給輕量模型 |
| | 用量統計 | 上下文用量和 token 統計 | 每次呼叫都記帳，存 400 天；每次任務一行小結（用時、來回次數、第一次反饋） |
| **安全與授權** | 動作審批 | 不先問；選哪些工具或 MCP 給 Bot 就是授權 | 「詢問」模式只問花錢的那一步；付款由使用者親手做；「自主」模式連付款也不問 |
| | 權限邊界 | 每個 Bot 逐組開關工具；只碰自己的資料夾；電腦分直接／容器 | 子任務唯讀；無人在場的任務遇到花錢的一步直接拒絕 |
| | 金鑰 | Keystore；雲端憑證不留在電腦上 | Keystore；記憶也加密 |
| | 已知弱點 | 直接模式下 Bot 可讀寫整個家目錄（文件已寫明） | 自主模式時 `ownApp` 保護失效；唯讀 JS 有繞過點 |
| | ToS 風險 | 低（走官方 API） | 高（自動操作第三方 App；README 有免責聲明） |
| **自動化** | 時間 | `create_schedule`、`schedule_followup` | `schedule_task`：一次性、固定間隔、每天或每週；固定提醒不呼叫模型 |
| | 事件 | 充電、Wi-Fi、地點、通知、解鎖、電量、耳機、車用藍牙、活動辨識、新照片 | 無；只有「條件任務」：用唯讀的網頁和沙箱定期檢查條件 |
| | 觸發前過濾 | 內建防線＋自訂是非題，classifier 判斷要不要叫醒 Bot | 只在條件從「不滿足」變「滿足」時執行 |
| | 次數上限 | 每則一天 10 次、全部 30 次 | 無 |
| **記憶與學習** | 記憶 | 全域與每個 Bot 各一份 MEMORY.md（上限 4000 字），`update_memory` 編輯 | 事實、偏好、做法（做法要批准）、使用者畫像；只從使用者原話記；過濾敏感資訊 |
| | 技能 | 內建 skills，`read_skill` 讀 | 內建 App／網站知識（18＋12）＋技能；個人技能自學與經驗回放（目前因核查關閉而不會發生） |
| **入口與 UI** | 多個身分 | 最多 12 個 Bot，各有工作說明、頭像和記憶 | 單一 Mika，多個對話 |
| | 系統入口 | 數位助理（長按側邊鍵）帶入目前截圖；分享給 pi | 懸浮膠囊（無障礙浮層）；雙擊膠囊送出目前這一屏 |
| | 看到 agent 在做什麼 | 工具步驟即時輸出 | 對話頁子母畫面即時顯示虛擬螢幕；可回看的執行時間線 |
| | 附件 | PDF、docx、xlsx（匯入 SQLite）、手機上 OCR、QR／條碼、掃描文件 | 照片與檔案放進沙箱 `/workspace/inbox`；自己的檔案檢視頁 |
| | 通知風格 | 不用 toast | 系統通知三個頻道；要使用者處理時用膠囊和卡片 |
| **答案品質** | 來源與佐證 | 模型自己寫 | 系統從證據帳本產生「來源」；`Grounding` 核對數字（目前關閉） |
| | 結局判定 | — | 回答送出後，背景用 `OutcomeJudge` 分成 Done／Partial／NotPossible |
| **工程紀律** | 註解 | 禁止，只允許 `// why:`，由 check 強制 | 大量中文 KDoc 和行內註解 |
| | 測試方式 | Platform seam 跑真實實作，不用 mock；contracts 測試；裝置上用 CDP 操作 UI | 假模型跑主迴圈快照、提示詞金樣、套件依賴方向測試、裝置測試 |
| | 評測 | `model-eval.sh`（弱模型對比）、`tool-cost.sh` | 約 150 題實機評測，tune／holdout 分池；`answer_grounded` |
| | 效能 | S24 120 Hz 實機量測（`test/perf/run.ts`），改動前後都量 | perf 建置類型＋ baseline profile；沒看到正式量測流程 |
| | 文件 | 繁中，按現狀寫，原因放 `docs/` | 簡中，按現狀寫，非常詳盡 |

## 5. 值得 pi mobile 借的，按效益 ÷ 成本排

1. **給 `use_phone_screen` 每步加等待條件**（類似 `expect` / `expect_gone` / `wait_stable`），由程式讀畫面等待，省下「還在載入」的模型來回。改動小，效益直接。
2. **每個動作回報實際效果，並讀回打的字**：減少模型「以為點到了」。Mika 的 `ActionEffect` 和 `treeBlind` 的區分可以照抄概念。
3. **無障礙樹不夠用時用 OCR 補讀**：pi mobile 已經有 ML Kit（附件 OCR），補到 `read_phone_screen` 上的成本不高；對 Flutter、自繪介面的 App 有幫助。
4. **主迴圈快照測試**：和現有的 `tools.snapshot.json` 同一個思路，可以延伸到 contracts 測試，鎖住每次請求送出的系統提示、工具清單和前綴是否不變。
5. **系統產生的「來源」**、**停止後的交代**：都是主迴圈層的小功能，需要先確認 pi-durable 有沒有對應的掛鉤。
6. **背景虛擬螢幕 + 自建 ADB shell helper**：Mika 的核心，也是 pi mobile 最大的缺口（在背景操作第三方 App），但成本最高，且要寫成 Capacitor 原生外掛。要做的話，先用 Mika 的 `core/adb/` 和 `HelperProcess.kt` 在 S24 上驗證可行性再決定。

不建議借的：擬人化節奏與躲偵測的做法（ToS 風險）、只問花錢的審批模型（和 pi mobile「選工具就是授權」的設計不同，換過來沒有明顯好處）。

整個手機代理的版圖、背景操作的可行性與 Play 政策，見 [phone-agents-landscape.md](phone-agents-landscape.md)。
