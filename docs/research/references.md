# 使用者分享的參考與學到的事

使用者看到好東西就會分享過來。這份記下每一個參考：從中學到什麼、對 pi mobile 的決定是什麼、做到哪裡。之後做設計或功能前先讀這份，新的參考也記在這裡。

## 原則：先定核心目的

2026-11-13，使用者看了 iPad 工作台的第一個方向後說：「這個工作台設計是要成為真正的生產力工具的，而不是單純把東西放上去而已，記住，你做事情是要有核心目的的。」

所以做任何畫面或功能之前，先寫下它的核心目的：它讓使用者完成什麼事、少做哪幾步。每個元素都要為這個目的服務。只是把資訊擺出來的東西，要嘛拿掉，要嘛收到點開才看到。做完之後量一次，例如從 Bot 交出草稿到使用者核准，要點幾下、花幾秒。

學到的參考，也照這個標準來取捨：看這個做法能不能讓使用者更快把事做完，而不是它看起來新。

## 原則：好 Bot 是使用者每天想主動打開的 Bot

2026-11-18，使用者說開源不是現階段的賣點，重點是好用、讓使用者覺得 Bot 幫到他的生活；又拿自己每天在用的 Grok Bot 當例子：「我就覺得我會願意去打開他，不管是 ui 漂亮，還是他會主動幫我確認每日新信件。要讓用戶每日主動想打開的 bot，才是好 bot。」

所以衡量一個功能，問的是：它會不會讓使用者明天還想打開 pi。打開的理由有兩種，兩種都要有：

- 打開就有東西等著他：Bot 已經主動做完的事（今天的新信件哪些要回、哪件事撞期），不是一個空的輸入框。
- 打開本身是享受：畫面漂亮、順手。外觀算體驗，不是裝飾。

同一天使用者補充：「該 app 並沒有社交屬性，重點在於『助理』的感受。」所以社群 App 靠的按讚、動態、別人的回應都不適用；要學的是被一個好助理照顧的感受：信得過、不用自己記著、它記得你、做完會回報、在對的時候才開口。研究見 [assistant-psychology.md](assistant-psychology.md)。

市場調研也用這個角度讀別人的產品：找使用者覺得「被幫到」和「想放棄」的時刻（Duet、Dots 的評測見 2026-11-18 的調研：最被稱讚的是抓到兩個 App 之間被漏掉的事；最傷的是誤判急不急、說了不重要還一直提、漏掉真正重要的）。

## 參考

| 參考 | 是什麼 | 學到的 | 對 pi mobile 的決定 |
|---|---|---|---|
| Lazy errands research（2026-11-15，使用者提供 `.errands-research.md`） | 把訂票、讀訊息、訂餐拆成畫面與模型往返成本 | 已知路徑應在原生一次做完；目標在每步執行時找，觀察和等待都屬於目標 display | 這次只做 #1、#2、#4、#5 和進度文字；#3 安全閘另做。Settings 模擬器測試與限制見 [errands-report.md](../design/errands-report.md)，沒有測那些真實交易 App |
| 使用者提供的 in-process XCTest probe（2026-11-15） | `.probe/PiXCT.m`、`ProbeApp.swift`：同一支 iPhone 上，不經 VPN / WDA 的 session、snapshot、touch、中文輸入、PNG 和背景音訊 | developer frameworks 需要 DDI 與 runpaths；snapshot 不要取 AX children；通知 shim 的參數要保留 raw ABI，不能把 scalar 當 `id`；audio source callback 不能繼承 MainActor | iOS OSS 的 private API 收在 `ios/AgentScreen/InProcess.m`，Swift plugin 負責 contract 和有限期的音訊保活；上架版不載入，量測與限制見 `.report.md` |
| scrcpy（背景螢幕預覽，2026-11-15） | 使用者指定的 Android 螢幕串流做法：MediaCodec 的 input Surface → H.264 → decoder Surface | 不把每幀變成 Bitmap，也不經 WebView；只在觀看時建立 encoder，靜止畫面不重複編碼 | 已在 API 36 模擬器實作。直接把小 Surface 接到全尺寸 virtual display 會裁切，改用等比例 density 的低解析度 display；量測與限制見 [背景螢幕預覽報告](../design/background-preview-report.md) |
| mthli/appine（2026-11-18） | Android 上的 Linux 終端機 App（AGPL-3.0，已上架 Play）：在 App 自己的程序裡用二進位轉譯跑沒改過的 Alpine／Debian aarch64 程式 | 單一程序、不靠 execve 和子程序，所以沒有 phantom process killer 和 W^X 的問題；模擬器上 `apk add python3` 3 秒、Python 迴圈約原生的 3 倍；開發流程用「每個模組一份地圖」和 commit 裡的結構化決定讓 agent 先讀到整條流程 | 見 [appine.md](appine.md)。比 PRoot 更值得先試，但 AGPL 不能嵌進 MIT 的 pi；可行的路是把 pi 的電腦端程式裝進 Appine、當成本機的一台電腦，沒試過。現階段重點是助理的感受，先記下不排進工作 |
| 做 App 的心理學（2026-11-18，使用者：「作 app 最重要的是心理學」） | X、Threads、FB、IG、TikTok、YouTube、Duolingo 和 AI 助理讓人每天回來的機制，只採一手研究和公司自己的發表 | 證據最強的是：內容切合使用者的目的、進度看得見、通知少而準（多送一般促銷會讓解除安裝率變高）、速度；可變獎勵讓人每天回來是作者的模型，沒有直接證據；pi 握有私人資料，資料只能用來完成交辦的事 | 見 [app-psychology.md](app-psychology.md) 第 7 節。先在使用者的 S24 上量一週「沒收到通知也自己打開」等指標，再挑「打開就有東西在等」做 |
| Grok Bot（2026-11-04；2026-11-18 補充） | xAI 的主動式 agent App，在 S24 上逐頁與實測交辦 | 對話裡的互動元件讓人多數時候點選不打字：問題卡（A–D）、工作時只顯示一行名字、先回一句再做事、結果卡、權限卡、做完老實交代未確認處、動作上的分級信任；畫面漂亮與每日主動看信讓人願意每天打開 | 已做：問題卡（`ask_user`）、工作行（`WorkLine` + `codemode.title`）、結果卡（天氣／頁面）、手機權限卡、先回一句與老實交代。還沒做：動作分級信任、表情回應、對話內連服務卡 |
| Claude Duet（2026-11-13） | Anthropic 的主動式 agent App，在 S24 上實測 | 「主動」是一套預設作息（晨報、白天少量巡視、夜間安靜時段、每日上限），並做成 skills；Chat／Tasks／Make 分成說話、交辦、成果；連服務從「它能做什麼」用途分組開始，空位畫虛線「＋」；草稿卡與權限卡分離；回答後附 ↳ 選項 | 已做：「能做什麼」用途分組、回答後 ↳ 選項、新 Bot 的晨報提議與 `morning-brief`／`daytime-check` skills。還沒做：任務板（可從 `note_item` 延伸）。不做雲端電腦與地區限定生活 skills |
| TP-Link Deco App 首頁（2026-11-13） | 網路設備的 App | 用一張有動畫的架構圖，一眼看出連線狀況和流量 | 已做：右側欄的「模型 ← 手機 → 電腦」連線圖，流量是真的位元組數，斷線有探測動畫，三個節點各自打開自己的設定 |
| deepseek-ai/chat-demo（2026-11-13） | DeepSeek 官方的網頁聊天範例 | 「已閱讀 N 個網頁」點開右側來源面板；正文用數字角標引用；思考時顯示已想幾秒；錄音時輸入框裡顯示即時頻譜；側欄可以收起 | 來源面板的目的是「讓使用者核對事實再行動」，放進 iPad 工作台的舞台。角標引用和錄音頻譜之後做，手機也受益。訊息分支不做，跟「每個 Bot 一條對話」衝突 |
| cloudflare/kitesurf（2026-11-13） | 跑在 Cloudflare Workers 上的實驗性瀏覽器引擎，講 CDP，支援無障礙樹，只傳畫面有變的區塊 | 可能給 Bot 一個不會睡著的雲端瀏覽器：手機鎖屏也能做完長任務；舞台的即時畫面和接手可以很省；和 computer use「文字優先」同方向 | 先做可行性測試再決定：用 Browser Run 讀目標網站，取無障礙樹，截圖，記速度和費用。需要 Workers 付費方案加上 Dynamic Workers；會擋機器人的網站不一定進得去 |
| Lauren Tan（poteto）〈All Code Is Slop〉（2026-11-12；2026-11-16 對照） | Grok Bot 團隊的工程紀律（`.pi/skills/` 的 `architect`、`blast-radius`、`correct` 改寫自她的 pstack） | 品質靠環境：架構 ＞ 靜態檢查 ＞ 驗證 ＞ 少量文字 ＞ 人工審查；每次糾正變成確定性檢查；禁用 `useEffect` 與零散計時器、禁止註解、功能地圖、驗證證據進 commit、關鍵協定用模型檢查（TLA+ 類） | 已全部落地並由 `npm run check` 強制：`useEffect` 歸零、計時器集中在 `pi-mobile-base/time.ts`（見 [../effects.md](../effects.md)）、`test/no-comments.ts`、`test/feature-map.ts`、`test/evidence.ts`、`test/resume-model.ts`、淘汰 `.group`/`.menu` |
| Ryo 的 agent 指揮台影片（2026-11-15，X @ryo_vibecoding，6 秒的桌面 App 錄影） | 一個「主 agent 帶一群工作 agent」的桌面 App：左邊是專案和每個工作 agent 一列（角色如實作或審查、用哪個模型、跑了多久、狀態）；中間上方是任務佇列，每件事的關卡進度（CI、審查第幾輪）畫成一段段小條；中間下方是跟主 agent 的對話；右邊是選中那件事的細節（誰在做、檢查結果、審查意見、改了哪些檔案）；最下面一條是各家模型的額度用量 | 感覺是「指揮台」：一眼看到所有工作 agent 的狀態，哪件事卡在哪一關，需要我的只有少數幾件；對話和指揮在同一個畫面，不用切換。使用者說只是給個感覺，不是要照抄 | iPad 工作台往「指揮台」走：手機上的 Bot 是主 agent，電腦上由 Herdr 和 Rex 管的 agent 是工作 agent。核心目的：使用者在 iPad 上一眼看出哪些 agent 在跑、哪件事需要自己，點一下就能看細節、回覆或接手。版面借 IDE 的分區概念（不借外觀）：活動列對應頭像條、檔案總管對應工作區與電腦 agent、分頁對應舞台、對話放一側 |
| affectUI（2026-11-15，[flohoeller/affectui](https://github.com/flohoeller/affectui)，MIT） | 給 AI agent 用的 React 19 元件庫（免費元件含 Tool Call Card、Decision Inbox、Change Summary、Resizable；Pro 含 Agent Tree、Trace Waterfall、Agent Sequence、Approval Gates） | 一次執行記成扁平 span 清單（`id`、`parentId`、`kind`、`status`、時間、tokens、成本），同一份資料可畫成 Tree／Waterfall／Sequence；等人的關卡在多工時收斂為依風險排序的佇列；Decision Inbox 答完短暫確認後下一件自動上來 | 不直接搬元件（樣式寫在元件內、用 `setTimeout`、有註解，與規則衝突），只借概念：工作後台先定 span 資料模型，從 pi-durable entries、watch、job、電腦 agent 投影出來，再選畫法 |
| Mika（2026-10-30、2026-11-15，[wangzan101/mika](https://github.com/wangzan101/mika)，Apache-2.0，讀碼未執行） | Android 原生 Kotlin agent，靠自建 ADB 無線配對＋shell helper 在背景虛擬螢幕操作第三方 App，並用無障礙樹＋ML Kit OCR 補洞 | (1) 入口工具常駐、呼叫後展開整組；(2) 任務開頭依已安裝 App 提示可用渠道＋App 筆記；(3) 每步帶 `expect`/`wait_stable` 等待條件與動作效果回報；(4) 提示詞金樣與主迴圈快照測試；(5) 背景虛擬螢幕不干擾主螢幕 | 已做：`phone_open_as_user` 常駐並 `loads` 同組工具、每則訊息比對已安裝 App 並附 Bot 自學的 `phone_note_as_user` 筆記（依 General first 原則不預寫 App 知識）、背景虛擬螢幕（見 [../design/background-screen.md](../design/background-screen.md)）、`use_phone_screen` 步驟等待與驗證。不借：擬人化防風控節奏（ToS 風險）、只問花錢的審批模型 |
| DSH Go（2026-10-30，[ccch1mneyyy/dsh-go](https://github.com/ccch1mneyyy/dsh-go)，AGPL-3.0，讀碼未執行） | DeepSeek Harness 的 Android 客戶端：PRoot 跑 Ubuntu + Node，Flutter 外殼，手機操控改寫自 Phase（無障礙＋Shizuku/ADB 背景螢幕） | (1) 原生層硬安全閘門（不讀自身、系統頁、密碼框、`FLAG_SECURE`、遮罩卡號身分證）；(2) 工具清單固定不隨權限改動以保 KV 快取；(3) 螢幕號＋元素編號＋動作前指紋核對；(4) 動作後等穩定、回報有無變化、`type` 讀回驗證、`collect` 一次捲讀長清單 | 已借概念重寫（AGPL 不可搬碼）：`use_phone_screen` 先等事件再等安靜、重抓、`unchanged` 回報、`type` 讀回核對。不借：PRoot Ubuntu 環境（iOS 不能跑、targetSdk 28 無法上架、APK 過大）、glibc direct launch（Android 16 seccomp 會殺）、預設遙測 |
| T3 Code / Lody / Paseo（2026-10-26，讀碼與設計文件未實測） | 三個「電腦 daemon 跑 agent、手機當遙控器」的開發工作台（T3 MIT、Lody/Paseo Apache-2.0） | 共通原則：連線活著 ≠ 工作還在 ≠ 結果已到；有副作用的操作不自動重送、結果不明就明說；狀態機與等待時間上限（Lody「已送出」30 秒上限、「正在工作」只來自 presence）；能力逐項協商不猜版本；一個擁有者（單一重連、單一面板位置）；正式版免 ADB 診斷記錄；重複排程錯過只跑最近一次 | 已落地（A1–A6、C3）：`StreamConnection` 區分送出前後斷線、Bot 面板顯示連線狀態階梯、容器準備改由明確動作觸發、`log.ts` 環形緩衝＋心跳＋分享診斷、移除電腦呼叫 `DELETE /pair`、重複排程錯過語意、側欄單一位置手勢。不引入：Relay／雲端推播、ACP 外部 provider、subagent、多人 CRDT、worktree 一級概念、核准框 |
| agent-desktop（2026-10-31，[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) v1.0.2，Apache-2.0，實測於 Mac mini） | Rust 寫的跨平台桌面 computer use CLI，讀 OS 無障礙樹做語意 headless 操作 | (1) 嚴格 ref 解析，元素身分排除會變的輸入框文字；(2) 送達語意 `disposition`（只有 `not_delivered` 可自動重試）；(3) 條件式等待與 `surfaces` 彈出層回報；(4) 原生 App 背景 headless 操作可行（計算機實測不搶焦點）。但三題網頁表單實測（`gpt-6.1-sol` low）：輸入 tokens 是 `pi-mobile mcp computer` 的 15–47 倍（未快取 2.5–8 倍）、時間 2.7–8.4 倍，且 Chrome `<select>` headless 全部失敗須退回 `--headed` 搶游標 | 不取代 `pi-mobile mcp computer`；只借送達語意、穩定指紋與條件式等待概念。若日後有背景操作原生桌面 App 需求，可為 `mcp computer` 評估 AX 語意動作 |
| OpenMausBot / openbot.run / CopilotKit OpenBot（2026-11-15，讀碼未執行） | 三個開源 agent 工作台，共通點是 agent 跑在桌機或伺服器、手機只是遙控器（openbot.run 為 PolyForm Noncommercial） | Bot／對話／指派三者分開與指派樹（OpenMausBot）；重啟時看證據避免重做已對外動作；「需要你」分卡住與巡查、活動紀錄從對話推導、接手時直接拒絕 agent 動作（CopilotKit OpenBot）；側邊分頁註冊表與可降級互動區塊（openbot.run）；叫醒模型前先做確定性檢查 | 概念併入 [agent-back-office.md](agent-back-office.md)。不採用：預設全權存取、伺服器中心／自建中繼、AG-UI 接工作 agent、A2UI React renderer、openbot.run 程式碼（非商用授權） |
| A2UI 與 AG-UI（2026-11-15，讀 README 與規格） | Google A2UI（宣告式生成式 UI 規格＋受信任元件目錄）與 CopilotKit AG-UI（前後端 ~16 種事件傳輸規格） | A2UI 的「元件目錄＋函式呼叫者限制」讓 agent 在受控元件內畫互動畫面；AG-UI 解的是跨網路邊界的事件標準化 | AG-UI 現在不需要（pi mobile 的 agent 與畫面在同一個 WebView，電腦端 CLI 也不講 AG-UI）；A2UI 概念已用在 `src/interaction/` 的結構化卡片，不採用其 React renderer（與 `DESIGN.md` 衝突且版本變動快） |
| database-architect 指引（2026-11-15，對照 S24 SQLite 3.50.6） | 以 PostgreSQL 為主的資料庫設計指引 | 約束放進資料庫（`STRICT` 表、`NOT NULL`、`CHECK`、`UNIQUE`、外鍵 `ON DELETE`）、金額存整數避免浮點誤差、改結構與驗證查詢放同一交易、不可逆刪除先問使用者；多租戶／RLS／線上遷移不適用單機 SQLite | 轉成內建純文字 skill（用到才讀，不進系統提示）；試算表匯入建 `STRICT` 表並加 `NOT NULL` |
| Agent Skills 生態與 skill loader（2026-11-15，讀碼與文獻） | Anthropic Agent Skills、pi coding agent 1.5.2 `SKILL.md` 與 SkillsBench 論文（通過率 33.9% → 50.5%） | 系統提示只列 `<available_skills>` 名稱與時機、用到才讀全文；手機 just-bash 沒有 Python/Node，腳本類 skill 跑不動但純文字流程 skill 可用 | 已做：參考 pi coding agent 的 `SKILL.md` 格式與 `read_skill`，另加每個 Bot 自己的純文字 `save_skill`（排程無人在場時禁止寫入）。不做：手機管理電腦上的 skill（交給電腦端 agent 管）、從外部內容自動安裝或帶憑證跑腳本 |
| Rex server（2026-10-27，讀官方文件） | Superlogical 的終端機 multiplexer，封閉 beta，支援 Personal／Shared／Login 模式、內建 Tailscale 辨識來源、自描述 API、OSC 7501 Program Status Protocol | 連線與加密交給 Tailscale（WireGuard）；Login 模式升級不斷 session；OSC 7501 用終端跳脫序列回報 `idle`/`working`/`blocked` | 連線與 TLS 照 Rex 交給 Tailscale，但多加配對金鑰（防同機其他 App 經 VPN 連入，見 [../design/computer-host.md](../design/computer-host.md)）。因封閉 beta 且未公開 client 協定，不當連線層，只在電腦端透過 `rex` CLI 互動（`src/computer-agents/`） |
| ego-browser（2026-10-23，Mac mini 實測 ego lite 0.6.0.12） | ego lite 附帶的 CLI，透過 Mach bootstrap 把 JS 送進瀏覽器 Node helper 以使用者 profile 操作網頁 | (1) 只有 macOS/Windows，容器無法連 Mach 服務；(2) `snapshot()` 每個文字節點約 200 bytes 截斷（UTF-8 中文約 66 字，還會切斷多位元組），讀文章要用 `page.evaluate()` 限長、找按鈕才用 `snapshot()`；(3) 同名 TaskSpace 會被不同 Bot 共用；(4) `ego-browser skill` 輸出約 23 KB（~6k tokens）；(5) `-e` 遇未關 stdin pipe 會卡住（`/exec` 須 `< /dev/null`，pi-env 已用 `Stdio::null()`）；(6) SIGTERM 殺 CLI 停不下已送入 helper 的腳本 | 寫入直接模式電腦提示詞（`src/agent/sandbox/sandbox.ts`）：命名 space 避免跨 Bot 共用、用 `evaluate()` 讀內容並限長、遠端交接講明電腦與 space、腳本保持短小 |

