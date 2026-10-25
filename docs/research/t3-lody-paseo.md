# T3 Code、Lody、Paseo：手機上的開發工作台，與 pi-mobile 的取捨

研究日期：2026-10-26（UTC+8）。範圍是官方文件及固定版本原始碼，不是安裝後的體驗評測。沒有啟動三家的 daemon、登入帳號、匯入憑證、安裝手機 App 或執行其測試；沒有對流暢度、耗電、可靠性或價格做排名。

## 先說結論

**三者的共同方向是「從手機操作電腦上的 agent」；pi-mobile 是「agent 在手機上，把部分工具交給電腦」。** 手機畫面相似，執行與資料的責任卻不同。[T1]、[L1]、[P1]、[PI]

以目前「S24 + Mac mini 容器、從 App 完成開發」的需求，我的研究優先序是：

1. **Paseo：優先拿來對照完整的手機開發流程。** 對話、worktree、終端、diff、PR、語音與多主機放在同一個產品裡；先觀察怎樣讓使用者確認環境、檢查產物和完成工作，不是先移植框架。[P0]
2. **T3 Code：優先讀連線與狀態管理。** 一個環境只有一個重連擁有者；連線恢復與資料更新分開；接收命令與完成副作用分開。這些約定比它用了哪個 UI 框架更值得借鏡。[T2]、[T3]
3. **Lody：優先理解多人共享、接手和 agent 能力協商。** 它不是單純的手機遙控器。若目前不需要多人共用工作空間，就沒有理由一起引入它的雲端與協作複雜度。[L1]、[L2]、[L3]

這是適用性判斷，不是已實測「Paseo 最好用」或「T3 最穩」。也不是建議把 pi-mobile 改成以上任一專案的客戶端。

## 來源版本與證據等級

| 專案 | 本次讀取的 main commit | 公開原始碼範圍與授權 |
| --- | --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code) | `5b35402623d7d1d88eaa472807272a6c2e78012a` | MIT；公開 server、web、Electron、mobile 與共用 runtime [T0]、[T-LICENSE] |
| [Lody](https://github.com/LodyAI/Lody) | `91fa467a205c71966b715356a7bf04b501fbb199` | Apache-2.0；公開 CLI、Electron、共用套件；不包括 hosted backend 與 Web/mobile App 原始碼 [L0]、[L4]、[L-LICENSE] |
| [Paseo](https://github.com/getpaseo/paseo) | `d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed` | 自有程式 Apache-2.0，第三方保留各自授權；公開 daemon、Expo App、Electron、CLI、relay 套件 [P0]、[P7] |
| pi-mobile | `37b03eb3080a023e607958fd2efb9f0a6dc3fb2e` | 作為比較基底；本輪不改產品程式 [PI] |

下文的「文件」指官方說明；「程式碼」指已讀到對應實作；「建議／推論」不表示功能已完成。main 上有實作，不代表商店版已包含它，也不代表每個 provider 都有相同能力。

## 一張對照表

| 面向 | T3 Code | Lody | Paseo | pi-mobile |
| --- | --- | --- | --- | --- |
| Agent 在哪裡跑 | workspace 所在電腦的 server | 已連接的 machine，由 CLI 啟動 ACP agent | 自有電腦／VM／容器中的 daemon | 手機的 pi-durable harness |
| 手機角色 | agent 控制介面 | 共享工作空間的客戶端 | 開發環境的客戶端 | 對話、排程、agent 與手機能力的主機 |
| 電腦關機後 | 該環境不能繼續工作 | 該 machine 不能繼續工作 | 該 daemon 不能繼續工作 | 手機工具仍可用；指定的遠端環境不可用，不應默默換地方 |
| 行動平台 | 官方列 iOS／Android；Expo 原始碼 | 官方列 iOS／Android；原生客戶端不在公開 repo 範圍 | Expo iOS／Android／web；Electron 桌面 | 目前實作與驗證重心在 Android |
| 遠端連接 | T3 Connect、直接配對、LAN／Tailscale；另有桌面 SSH 功能 | machine 連入 workspace；雲端產品與 OSS local-only 桌面要分開看 | 直接連接、VPN、可選 E2EE relay；另有桌面 SSH 隧道 | Tailscale 同使用者授權，電腦 `/exec` |
| 特別值得看 | reconnect、durable command、checkpoint、跨端一致性 | 真正接手同一 session、團隊授權、ACP capability | 手機開發流程、worktree、timeline 補齊、relay 配對 | 手機工具、手機上的對話與長期憑證、可更換工具執行環境 |

來源：[T0]、[T1]、[T5]、[L0]、[L1]、[L4]、[P0]、[P1]、[PI]。電腦關機一列是執行位置帶來的推論，不是本輪斷電測試結果；手機型產品也仍可能需要模型服務的網路。

## T3 Code

### 1. 不只包住聊天畫面

**文件與程式碼：** provider process、terminal、Git、檔案與持久狀態屬於 server；客戶端共用 `packages/client-runtime`，提供平台儲存、網路與前景／背景訊號。遠端環境失效，不能改用客戶端自己的檔案或憑證。[T1]

README 列出的 provider 並不是完整原始碼能力清單：本次 `apps/server/src/provider/builtInDrivers.ts` 已註冊 `PiDriver`、`MuseDriver`、ACP Registry 等。因此不能簡化成「T3 不支援 Pi」。但這也沒有證明商店版的功能或外掛相容性。[T0]、[T4]

### 2. 最值得學的，是誰擁有重連

**文件與程式碼：** `connection/supervisor.ts` 統一管理 retry，而不是每個 React view 都發起重連。它有帶 jitter 的指數退避，上限五分鐘；離線或認證問題不在條件不變時一直耗費嘗試。一般回到前景先 probe；長時間 mobile suspension 則可以直接換 session，避免等一條被 OS 靜默殺掉的 socket。[T2]

另一個關鍵約定：

- socket 已開 ≠ server 初始設定已收到；
- transport 健康 ≠ 某個 thread 的資料已更新；
- 暫時斷線 ≠ 使用者移除環境；
- 訂閱可跟隨新 session，**有副作用的命令不能因重連而一律重送**。[T2]

我讀到 `rpc/client.ts` 的一般 request 取得目前 session 後呼叫一次；持久訂閱另有 session replacement／retry 的路徑。這個界線對 push、merge、部署與發訊息尤其重要。[T2]

### 3. 收到命令與做完工作分開

**文件與程式碼：** orchestration v2 把 command receipt、events、projection、effect outbox 放在同一個 transaction；提交後才發布事件與執行後續副作用。`EventSink.commitCommandEffect` 先 `insertIfAbsent(commandId)`，重複命令取回原結果，而不是重新記一份意圖。[T3]

這提供的是命令接收／狀態的冪等性，不是「任何外部 shell 指令 exactly once」的證明。官方文件也特別說，綁在已消失 provider process 的 effect 不能直接重播。[T1]、[T3]

Checkpoint 用隱藏 Git refs 保存 workspace，不往使用者分支塞提交；但回退必須同時考慮檔案和 provider 對話。不支援回退對話的 provider，應先拒絕，不能只把檔案倒退。[T1]

### 4. 連接與推播有不同依賴

**文件：** T3 Connect 用 Clerk 身分與 managed tunnel。relay Worker 主要做 discovery、連結與一次性 credential 的仲介；正常 HTTP／WebSocket 之後走環境的 tunnel hostname，automation webhook 是另一路例外。[T6]

DPoP 綁定、一次性 credential、RPC scope 都是認證／授權機制，**不等於 conversation payload 的應用層端對端加密**。官方也明說 relay 的簽署權限是信任前提。「relay Worker 不代理聊天」不能推成「整條隧道只有手機和電腦兩端能解密」。[T6]

**文件：** 背景推播需要 T3 Connect；只有 direct／Tailscale 連線不會自動得到推播。Live Activity 或 Android 持續通知是遠端工作狀態的呈現，不是手機正在跑 agent 的證據。[T7]

初始 agent permission mode 是 **Full access**；各 provider 實際限制不同。測試時不能假設第一次連接就有嚴格 sandbox。[T8]

**文件落差：** mobile README 還寫「未發行」，主 README 已連到商店，App Store 也能找到該產品頁。不能只讀其中一句判定現況；本輪沒有下載或驗證特定地區可用性。[T0]、[T9]

## Lody

### 1. 核心價值是接手工作，而非分享逐字稿

**文件：** 隊友加入同一個 session，取得對話、diff、worktree，能繼續下指令；Markdown 匯出、截圖或複製 URL 不等於取得這些權限。Session fork 是另一件事。[L1]、[L2]

這點對 pi-mobile 的啟發不是立刻做團隊功能，而是：交接產物需要帶著 **repo、commit、工作目錄、驗證結果和權限範圍**，光是「模型說完成」不夠。這是建議，不是兩個產品已有互通格式。

### 2. ACP 是協定，不是所有 agent 都一樣

**文件與程式碼：** CLI 在本機 workdir 啟動 ACP process；初始化時協商能力。Lody 擴充放在 `_meta.lody`，各功能獨立宣告，沒有宣告就不能當成支援。`normalizeAcpSessionCapabilities` 對 fork、acknowledged steering 等能力明確以 `=== true` 決定。[L3]

官方能力表包含 Pi adapter，但 Pi 的 resume、fork、MCP、steering 等欄位並非全部相同。這是 adapter 宣告與協商結果，不是本輪逐項測試。[L3]

**建議：** 若以後讓 pi-mobile 控制外部 agent，先定義需要的協定能力，不要看到「支援 ACP」就預設能恢復、分支、插話、顯示用量或保留所有 pi extensions。現在只是比較，沒有新增 provider／toolset。

### 3. 公開 repo 不等於完整雲端產品可自架

**文件：** 公開範圍排除 hosted backend、operator／billing configuration、Web/mobile App source；OSS desktop 被明確定義成 local-only，不能發 authenticated product-cloud requests。[L4]

所以應分清楚：

- 可閱讀與修改 CLI／Electron／共用套件；
- 官方雲端多人產品如何使用；
- 是否能獨立部署相同的手機＋雲端協作產品。

前兩件有資料，不能據此承諾第三件。本輪也沒有驗證完整的無雲端手機工作流程。

### 4. CRDT、E2EE 與權限，不能混成一句「安全同步」

**文件：** Lody 使用 Loro／Flock，完整 local-first 仍是進行中的目標。README 說 `e2ee-core` 尚未接入產品；程式碼已出現 machine key custody 等基礎建設，但這不足以證明官方多人 session 已全程 E2EE。[L0]、[L5]

官方雲端隱私政策列出 conversation content／workflow context，及 Convex、Cloudflare、PostHog、Sentry 等服務；不能把這份雲端政策和 OSS desktop 的 local-only／telemetry disabled 混為一談。政策頁標示更新日期為 2026-03-01，本輪沒有稽核實際網路流量。[L4]、[L6]

**文件：** machine 預設 private，但「分享一個 session」可能需要分享整個 machine／local project，讓其他 conversations 也變得可見。這是授權範圍，不是 UI 文案的小差異。[L2]

CRDT 解決共享狀態合併，不自動保證 shell 副作用只執行一次，也不等於隔離隊友的主機權限。這是系統設計上的界線，不是在宣稱發現了 Lody 漏洞。

## Paseo

### 1. 最貼近「手機完成開發」的對照組

**文件：** daemon 留在自己的電腦、VM 或容器，管理 coding agents；Expo App、web、Electron、CLI 操作它。產品涵蓋 worktree、檔案、diff、terminal、PR、語音、多主機與 agent orchestration。[P0]、[P1]

**程式碼：** Pi adapter 的 `PiCliRuntime` 以 JSONL RPC child process 啟動 Pi，cwd 與環境是 daemon 那一端的。它不是把 Pi agent loop 搬進手機。[P2]

README 的「mobile is the full app」是產品定位，不足以證明每個原生／web／桌面功能完全相等；本輪沒有逐功能、鍵盤、檔案編輯或效能實測。

### 2. 連線恢復後，歷史不能只看 socket

**文件與程式碼：** live stream 提供即時性，authoritative timeline 負責補齊。source sequence、epoch 與 projected item 不混用；一個工具的多個更新可以投影成同一張卡。[P3]

- Live sequence 出現缺口，要沿 cursor 補到 `hasNewer: false`。
- 開啟／回到對話則先取有界的最新 tail，舊資料往上翻，不要求首次恢復把全部歷史下載完。
- 連線恢復與訊息更新有各自的狀態；cache 可以看，不代表最新。
- 相同 epoch／maxSeq 不替換整份 timeline，避免回到 App 就改動使用者向上捲到的位置。
- 背景回來要檢查 nominally connected 的 socket；這不是防止 OS suspend 的手段。[P3]

我讀到 `viewed-timeline-sync.ts` 的 `fetchUntilCurrent`：檢查 generation、續抓下一頁、拒絕 `hasNewer` 卻沒有 cursor 的回應，失敗保留 error 並退避。這些是可定位的實作，不只是介紹文字。[P3]

**對 pi-mobile 的限制：** 現在對話權威資料就在手機 IndexedDB，不是遠端 daemon；不能直接套用整套遠端 timeline replica。可以借的是「工具結果是否確實收到」與「連線是否活著」分開判斷。[PI]

### 3. Relay 的 E2EE 有實作，也有相容性條件

**文件與程式碼：** 新安裝先取得配對同意才啟用 relay；daemon 主動向 relay 連出，手機從另一端接入。正式 relay server 是另一個公開的 Elixir 專案，monorepo 內 Cloudflare relay 是 legacy，不應拿錯實作來描述正式服務。[P1]

新版 peers 使用 `Noise_NK_25519_ChaChaPoly_SHA256`，有 counter 與 fresh daemon ephemeral。舊 peer 仍可能使用 NaCl box legacy 模式；舊模式缺少 replay protection。`config.ts` 的 `requireProtectedSecurity` 預設確實是 `false`。[P4]

新版客戶端會把已協商過的 protected 模式綁到 daemon identity，避免重連降級；但 client pin 不能替 daemon 拒絕其他 legacy clients。要完整拒絕舊模式，需要 daemon enforcement；切換設定也不會自動斷掉已存在的 legacy sessions。[P4]

這些是官方已公開的威脅模型與相容性限制。本輪沒有做滲透測試，也不把「用了 Noise」稱為已完成獨立安全稽核。

### 4. Worktree 與 E2EE 都不是執行 sandbox

**文件：** daemon 客戶端是受信任的操作方；file preview 可以讀 daemon 帳號可讀的 regular file。工作目錄相對路徑不是安全邊界。權限文件也明說目前 grant 是 daemon-wide，workspace-scoped authority 尚需完整的 resource enforcement。[P5]

E2EE 保護通訊，不能阻止已獲授權的 agent 修改主機；worktree 避免檔案變更混在同一 checkout，也不是不同 OS 使用者或容器。Docker 可以限縮宿主暴露面，但掛入的 workspace／credentials 仍在可及範圍。[P5]

官方「code never leaves your machine」不能擴大解讀成「模型一定本機推論、內容永遠不會送出」：Paseo 包的是使用者設定的 agent/provider，這些服務的資料處理必須另外看。[P0]、[P5]

## 對 pi-mobile 的具體建議

### 優先：讓現在的流程可觀察、可驗證

1. **環境狀態要有明確來源，不靠 View 不斷嘗試來維持。** 借 T3 的 ownership 原則，先測主機連線、pi-env handshake、容器準備與工具執行各自的生命週期。剛修好的 host identity 迴圈就是實際案例；這不是建議再加一個通用重試 framework。[T2]、[PI-FIX]
2. **把遠端開發的證據帶回同一個 App 流程。** 本次容器已證實有 Node/npm；下一個有價值的測試是 App 內完成修改、check、build、diff 檢視，能核對工作目錄／commit／exit code。不要又退回桌面替 App 跑完，然後只貼「通過」。這是工作流程驗收建議，不代表本輪又做了開發測試。[PI-FIX]
3. **延續「不確定就明說」，不要自動重送有副作用的操作。** pi-mobile 既有 `StreamConnection` 已合併建立連線的 promise、以 session 限定 request，斷線時 reject pending，而不是盲目重播。要確認的是回到 UI 的結果是否讓人知道「失敗」與「結果未知」的差別，不應假設這套保護完全缺席。[PI-CONN]、[T2]
4. **先看檔案／diff／驗證結果如何接上對話。** 借 Paseo 的流程與 Lody 的交接語意，不是把終端、編輯器、團隊、瀏覽器、多 agent 卡片一次堆進畫面。

### 有需求才做

- **ACP／外部 provider adapter：** 只有真的要從 App 控制既有 Claude Code／Codex／Pi session 時才需要。更換模型 API 並不等於要新增整套外部 agent host。[L3]
- **Relay／推播：** 只有 Tailscale onboarding 或長時間離線通知成為明確障礙時再評估。要一起決定誰持有身分、誰能解密、誰能撤銷、帳號依賴與營運成本，不能只抄 QR code 畫面。[T6]、[T7]、[P4]
- **團隊協作／CRDT：** 有跨人共用同一 session 的需求才評估；多個私人 Bot 不等於多人共同編輯。[L1]、[L2]
- **長工作留在電腦：** 可以形成另一種產品模式，但不是把 tool sandbox 換成容器就自然得到。現有架構已記錄不做 subagent／child task 的決策；這份研究不推翻它。先用真實長指令與斷線重現成本，確定需求後再另行討論。[PI]

### 不直接照搬

- 不為了「他們也用」就把 Capacitor 改成 Expo／Electron。
- 不因為他們有 iOS Live Activity 就推論 pi-mobile 的 WKWebView 可持續跑 agent。
- 不把 worktree、資料夾分隔、permission prompt 或 E2EE 當成彼此可替代的安全邊界。
- 不把手機端長期憑證移到遠端來換取方便，卻還沿用「憑證只在手機」的承諾。
- 不從遠端型架構反推 pi-mobile 應放棄手機原生工具。它們解決的重點不同。

## 下一輪如果要實測

這是待執行計畫，不是成果。先從 Paseo／T3 二選一，以一次一個產品的方式測，避免污染常駐服務；Lody 若需雲端帳號或分享機器，先確認資料及授權範圍。安裝、登入、授權與修改常駐服務另行取得同意。

| 情境 | 可驗證的成功條件 |
| --- | --- |
| 手機選 Mac mini 上的隔離 workspace | 顯示／實際命令的 cwd、repo、HEAD 一致，不落到另一個環境 |
| App 下指令修改小型專案並跑測試 | 保留實際 diff、exit code、測試輸出；不靠桌面代理完成 |
| 長指令中斷線 30 秒再回來 | 不漏最終結果、不重跑有副作用的命令；結果不明時明確呈現 |
| 背景五分鐘、關閉再開 App | 分別記錄 host agent 是否仍跑、client 是否恢復、資料是否補齊，不能合併算一個「背景成功」 |
| Permission request 等待時切換裝置 | 明確知道哪個 session／環境的請求；不重複批准、不批准過期請求 |
| 長對話往上捲，再回到前景 | 不任意跳底；記錄 S24 120 Hz 的 frame time、CPU、記憶體，不只主觀說順 |
| 兩個隔離 worktree | 改動與驗證結果可歸屬到正確工作，不假裝是 OS 隔離 |
| 撤銷裝置／取消分享 | 舊 client 不再有存取權；歷史 cache 的處理與線上授權分開檢查 |

比較時固定實際安裝版本、agent/provider 版本、模型、prompt、專案與測試資料；分開記錄 hosted relay 和 Tailscale 直連。使用合成資料，不發布配對連結、token 或私人對話。沒有原生 client 的實測，不能以 web 頁面代替手機結論。

## 第一手來源

所有 GitHub 程式碼／文件連結固定在本次讀到的 SHA；商店頁是研究當時查詢結果，不是版本固定的來源。

[T-LICENSE]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/LICENSE
[T0]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/README.md
[T1]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/overview.md
[T2]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/connection-runtime.md
[T3]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/EventSink.ts
[T4]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/provider/builtInDrivers.ts
[T5]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/remote-access.md
[T6]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md
[T7]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/mobile-notifications.md
[T8]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/permission-modes.md
[T9]: https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824
[L-LICENSE]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/LICENSE
[L0]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/README.md
[L1]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(guides)/team.mdx
[L2]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(guides)/session-handoff.mdx
[L3]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(migrating)/acp-feature-support.mdx
[L4]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/AGENTS.md#repository-boundary
[L5]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/apps/cli/src/lib/e2ee/custody.ts
[L6]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/pages/en/privacy.mdx
[P0]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/README.md
[P1]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/architecture.md
[P2]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/packages/server/src/server/agent/providers/pi/cli-runtime.ts
[P3]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/timeline-sync.md
[P4]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/relay-endpoint-security.md
[P5]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/SECURITY.md
[P7]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/LICENSE
[PI]: https://github.com/geminixiang/pi-mobile/blob/37b03eb3080a023e607958fd2efb9f0a6dc3fb2e/docs/architecture.md
[PI-CONN]: https://github.com/geminixiang/pi-mobile/blob/37b03eb3080a023e607958fd2efb9f0a6dc3fb2e/src/agent/sandbox/stream-connection.ts
[PI-FIX]: ./container-prepare-loop.md

### 可繼續追的實作入口

- T3：[connection supervisor](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/src/connection/supervisor.ts)、[RPC client](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/packages/client-runtime/src/rpc/client.ts)、[mobile README 的發行警告](https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/mobile/README.md)。
- Lody：[ACP process 啟動](https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/apps/cli/src/agent/acp-runner.ts)、[capability normalization](https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/apps/cli/src/agent/acp-capability-normalization.ts)。
- Paseo：[timeline catch-up owner](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/packages/app/src/timeline/viewed-timeline-sync.ts)、[HostRuntimeController](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/packages/app/src/runtime/host-runtime.ts)、[relay security default](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/packages/server/src/server/config.ts)、[semantic permissions](https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/permissions.md)。
