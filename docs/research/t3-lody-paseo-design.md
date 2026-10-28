# T3 Code、Lody、Paseo 的設計，與 pi-mobile 該引入什麼

研究日期：2026-10-26。接續 [t3-lody-paseo.md](t3-lody-paseo.md)（產品定位與來源界線）。本篇讀的是三者的設計文件與關鍵程式碼，再對照 pi-mobile 現在的文件與原始碼，給出分級建議。沒有安裝或實測三者；pi-mobile 的現況以原始碼與 `docs/` 為準，沒有新增程式。

來源版本：T3 `5b35402`、Lody `91fa467`、Paseo `d0fd2e5`、pi-mobile `1783b2a`。各段標註來源；「文件」指官方說明，「程式碼」指已讀到實作，「推論」是我的判斷。

## 一、三者的設計原則

三者都是「電腦上的 daemon 跑 agent，手機是客戶端」。它們解的核心問題是**遠端狀態的正確性**：socket 斷了、App 被殺了、daemon 重啟了，手機看到的東西還對不對。pi-mobile 的 agent 在手機上，這組問題大半不存在；但它把工具執行交給電腦，所以**工具呼叫那一段**面對同樣的問題。

### T3 Code：把「誰擁有什麼」寫成規則

**所有權界線。** provider process、終端、Git、檔案、持久狀態屬於 server；連線與領域狀態在共用的 `client-runtime`，三種客戶端只提供平台服務與 UI。遠端客戶端永遠不能拿自己的檔案系統或憑證代替環境的。[T-overview]

**身分與路徑分開。** 環境 ID 跨重啟與換位址不變；一台機器可以有多條路徑（LAN、Tailscale、公網、SSH、T3 Connect），客戶端依序試，連上後會在背景 preflight 更好的路徑再換過去。廣播的位址只是提示，只有連線的那台裝置能證明路徑可用；loopback 位址在另一台裝置上指的是別台機器，所以不能默默退回 loopback。[T-remote]

**一個重連擁有者。** `supervisor.ts` 擁有 retry：帶 jitter 的指數退避，上限五分鐘，連線維持住才重設；離線與認證失敗等待喚醒而不是耗費嘗試。回到前景、手動重試、系統報離線都只 **probe** 現有 session，probe 失敗才重連（離線回報常是錯的）。唯一例外是手機長時間背景後直接換 session，因為 OS 可能無聲殺掉 socket，probe 會讓它卡在「恢復中」直到逾時。[T-conn]

**連線健康與資料新舊分開。** socket 開了不代表環境可用：RPC session 要等到 server 初始設定到了才算 ready；thread 資料另有自己的同步狀態；一個失敗的訂閱可以與健康的連線並存，把它標成「重連中」是在承諾一個不會發生的重試。快取可以離線讀，但不能暗示連線存在，也不能在重連時蓋掉較新的資料。[T-conn]

**訂閱跟著新 session，有副作用的命令不自動重送。** 重連後持久訂閱自動接上替代 session；mutation 的重試與冪等規則屬於該操作本身。[T-conn]

**意圖與副作用分開。** orchestration v2 把 event、projection、command receipt、effect outbox 放在同一個 transaction，提交後才發布事件與執行副作用。`commitCommand` 先 `insertIfAbsent(commandId)`，重複命令取回原結果。命令被接受只代表意圖已記錄，不代表 provider 做完；綁在已消失 process 的 effect 不能直接重播。[T-overview][T-sink]

**turn 結束與收尾分開。** provider turn 結束和後續 checkpoint／diff／PR 偵測是不同里程碑，晚到的 checkpoint 不能延長顯示的執行時間。Checkpoint 用隱藏 Git ref 保存工作區，不往使用者分支加 commit；回退要同時處理檔案與 provider 對話，做不到對話回退的 provider 要先拒絕。[T-overview]

**設定不能是健康檢查的副作用。** 開 provider session 可能啟動 MCP server、跑 hook、開登入瀏覽器，所以狀態探測只做初始化，不做認證與建 session。[T-providers]

**能力協商，不看版本。** 客戶端與環境各自升級；功能以環境描述符宣告的能力決定，缺少能力時明確降級，新環境持續宣告舊旗標。[T-overview]

**授權是環境自己的。** 配對委派 scope，交換只能縮不能放；relay token 永遠不是環境登入；每個 RPC 宣告需要的 scope；長期 token 不進 socket URL（用短效 ticket）；guest link 是 HMAC、不進 session store。[T-auth]

**handoff 是有預算的選取，不是模型寫的摘要。** 切換 provider 時傳遞的是選出的原始訊息（最近的、最初的、相關的工具結果），連不下的參考也附上，放不下就報錯而不是縮短使用者的請求。[T-handoff]

**手機離線也能排隊。** 草稿附件留本機副本，離線可預覽與排隊，重連後續傳；登出保留。[T-composer]

**推播依附 T3 Connect。** 直連或 Tailscale 不給推播；App 不需要維持連線就能收到通知；Android 強制停止後推播失效。[T-notify]

### Lody：把多人與多 agent 的語意寫清楚

**ACP 客戶端，能力逐項協商。** Lody 啟動 agent 的 ACP process、在 `initialize` 協商；自己的擴充放在 `_meta.lody`，一個鍵代表一個功能，缺少就是不支援，支援一個不代表支援另一個。`normalizeAcpSessionCapabilities` 對 fork、steer 用 `=== true` 判定。[L-acp][L-caps]

**物件模型小而固定。** workspace → project → session（一個任務、一條對話、一個 branch/worktree）→ round（一次 agent turn 加它的 diff）。Agent Config 回答「這台機器能跑什麼、怎麼認證」；Agent Role 是「開始這類任務時選哪台機器、哪個 config、模型、權限、預設指令」的預設組合。被接受的操作凍結解析後的 Role，之後改 Role 不影響已接受的請求。[L-concepts][L-roles][L-catalog]

**接手、分支、分享是三件事。** 接手是隊友進入同一個 session 繼續；fork 是複製歷史到新 session；分享連結只是紀錄。分享一個 session 可能連帶分享整台機器，其他對話也變得可見，確認框要說明範圍。機器預設 private。[L-handoff][L-team]

**presence 與持久狀態分開。** 「正在工作」只能來自 presence，不能來自 session meta 的狀態欄位（它可能過期）。唯一的前端推導狀態是「已送出但還沒開始」，而且**有時間上限**（30 秒，錨在 turn 自己的持久時間戳，不是元件掛載時間），因為 daemon 當掉時 presence 永遠不會來，否則「開始中…」會永遠顯示。送訊息的路由有一個保守例外：presence 短暫消失時，未完成的 assistant transcript 視為排序障礙，一律排隊而不直接送，因為排隊對活的 turn 和過期的 transcript 都安全，直接送可能產生第二個 turn。[L-live]

**權限請求的契約。** 一個活的回答面（取代 composer 的位置）、用 provider 的原話、完整顯示會執行什麼、建議的答案永遠不是「以後都允許」、Escape 只拒絕一次、prompt 上的 Enter 不回答（避免原本要送訊息的 Enter 誤批准）、失敗要顯示且可重答、有 Stop。[L-perm]

**歷史寫入的契約。** 寫前驗證新 turn 與變更的欄位，拒絕無效命令但保留舊值；未知欄位與損壞項目保留不動（讀取不是遷移）；fork 是儲存歷史的複製不是新輸入；每個緩衝的 ACP 通知有穩定的 operation ID，重試時後端把已接受的 ID 視為冪等。[L-history]

**worktree 的保留與回收。** 封存後由擁有機器回收 Lody 管理的 worktree：先留本地分支、把未忽略的變更 commit 備份，再刪目錄；repo 解析不到或備份失敗就保留重試。還原時從分支重建並重跑 setup。[L-worktrees]

**排程的缺席語意。** 機器離線錯過時間，回來後只跑**一次**（最近的那次），不是每個錯過的時段各跑一次；上一輪沒跑完，下一輪最多等一個。Agent 只能提議排程，不能自己建立。[L-sched]

**失敗圍堵。** 一個 I/O 失敗不能擴散成「workspace 永遠關不掉」：繼續做不相關的清理再一起回報；終止邊界（退出、登出、刪除）有時間預算，未確認持久化就回報可能遺失，然後照樣結束；新的等待閘門只套在造成競態的那個操作上，不套在每次啟動；未確認的結果不能進成功快取。[L-failure]

**公開範圍。** OSS desktop 是 local-only、禁止呼叫產品雲端；`e2ee-core` 尚未接入產品；hosted backend 與手機 App 原始碼不公開。[L-boundary][L-readme]

### Paseo：把 daemon 的生命週期與同步做到可驗證

**agent 生命週期是狀態機。** `initializing → idle → running → idle`，`closed` 是沒有活的 provider runtime 但可恢復的持久狀態。idle 的 agent 無限期常駐，只有明確的生命週期動作才關閉。provider runtime 自己死掉時（crash、OOM、主機休眠），turn 之間沒有人在看，agent 會「看起來 idle 但背景工作已消失」——所以把退出回報成 turn 失敗，讓 agent 進入 `error` 並留下 timeline 項目。[P-lifecycle]

**中斷是冪等的，模糊的中斷不接受新工作。** 中斷在 provider 已經 idle 時也算成功；只有 provider 可能仍擁有 turn 時才拒絕。captured run token 防止舊的取消結算新的 turn。中斷被拒或逾時時，replace／reload／rewind／Stop 都回報失敗，不接受新工作，避免 split-brain。[P-lifecycle]

**佇列中的訊息在記憶體，收據才是真相。** 乾淨關機會 flush；突然當掉會遺失排隊的 prompt。持久的送出收據在實際派送確認前一直是 pending，遺失的視窗不會變成完成的收據。[P-lifecycle]

**兩條交付路徑。** live stream 負責即時，`fetch_agent_timeline_request` 負責正確。daemon 只保留投影後的項目，不保留中間 payload；provider 歷史是持久的 transcript 權威。連續訂閱的客戶端按序套用每一列；開啟或恢復用一個有界請求取得目前的尾端。補齊是分頁但完整（`hasNewer: false` 才算完成）。socket 連上不能證明顯示的對話是最新的；timeline owner 發布「新鮮度」，view 只渲染。相同 epoch 與 maxSeq 是精確的 no-op，不替換陣列，保住往上捲的位置。[P-sync][P-sync-code]

**presence 不是交付。** heartbeat（裝置、可見性、焦點 agent）只用於通知路由，不能當成 stream 交付的正確性閘門。[P-sync]

**串流節奏。** daemon 端 coalescer 每 60 ms 最多一則（leading + trailing）；App 端 reducer 每幀 commit 一次（計時器當上限，因為隱藏分頁沒有 frame callback）；顯示用 backlog 導出的速率逐步揭露，store 永遠持有全文；第一次看到的文字整段顯示，只有增長才分段；離開 streaming 時立刻補齊。歷史列只在 item 身分改變時重渲染。[P-stream]

**手機面板只有一個位置。** 左列表、中對話、右檔案是三個互斥目標，一個正規化位置（−1、0、1）導出所有 transform 與遮罩透明度；React 擁有持久意圖（target + revision），worklet 擁有暫態運動；手勢捕捉當時的 revision，較新的 React 命令清除手勢所有權。這讓「面板與遮罩不一致」「左右同時開」「寬度同步重設拖曳」變成不可表示的狀態。[P-panels]

**通知的目標要重新解析。** 通知帶 host 與 agent，忽略它的 workspace 提示（agent 可能已移動）；Android `singleTask` Activity 結束後 JS context 仍活著，去重 ID 要在模組層級；讀到 launch response 不等於已確認，要清掉，否則下次啟動重開舊 agent。[P-notify]

**權限是語意的、可加的。** `workspace.read`、`workspace.write`、`daemon.manage` 等；RPC 名稱不是授權；owner/operator/viewer 是 UI 預設展開成明確權限，不持久化成角色；沒有 deny 優先；委派只能給自己有的。agent 與終端共用 workspace 權限，因為兩者都能執行程式，分開會宣稱一個 daemon 做不到的隔離邊界。[P-perm]

**relay 不受信任，端點自己保護。** Noise NK，counter nonce，fresh daemon ephemeral；舊 peer 退回 NaCl box（無 replay 保護）；`requireProtectedSecurity` 預設 `false`；客戶端對已協商 protected 的 daemon identity 釘住，避免重連降級。[P-relay]

**資料模型。** 檔案式 JSON，atomic rename；project ID 不透明且不重新鍵入；workspace 的 `cwd` 與 `worktreeRoot` 分開（子專案在 worktree 內）；store 介面擁有原子性，呼叫者不該自己做 read-merge-write。[P-data]

**沒有 ADB 也能拿診斷。** dogfood build 把 JSONL 診斷寫到 Downloads：傳輸框架大小、連線轉換、解析／派送 span、具名 React 子樹渲染時間、前景 JS heartbeat 缺口（>500 ms 標記 stall），不含 payload 與密碼；八個檔各約 5 MiB 輪替。[P-android]

**產品哲學。** 精簡核心 + 外掛；一個功能即使正確也可能是錯的加法；從最小有效改動開始，留空間學習。[P-product]

### 三者共同的、而 pi-mobile 也要面對的

1. **連線活著 ≠ 工作還在 ≠ 結果已到。** 三者都把這三件事分開處理。
2. **有副作用的操作不自動重送；結果不明要說不明。**
3. **狀態機與時間上限**：任何「等待中」都要能超時並變成可見的失敗。
4. **能力用宣告，不用版本或名字猜。**
5. **一個擁有者**：重連、面板位置、prepare 動作，各只有一個地方負責。
6. **可觀測性是功能**：沒有除錯工具時仍要拿得到證據。

## 二、pi-mobile 現況對照

| 面向 | pi-mobile 現況（來源） | 與三者的差異 |
| --- | --- | --- |
| agent 位置 | 手機 pi-durable；對話、金鑰在手機 IndexedDB／Keystore [PI-arch] | 根本差異：三者的同步問題大半不存在，但工具呼叫段落相同 |
| 電腦連線 | `StreamConnection`：合併建立中的連線、request 綁 session、ping 5 s／30 s 靜默就 teardown、teardown 時 reject 所有 pending；下次 request 才重連 [PI-conn] | 沒有 supervisor 式的主動重連與退避；但因為 agent 在手機，「下次用到才連」是合理的 |
| 斷線時執行中的指令 | host 端 `/env`、`/exec` 各是一個 process group，手機連線斷了就 SIGTERM、2 秒後 SIGKILL [PI-host-doc][PI-host-go]；security.md 明寫「鎖屏時網路短暫中斷，sandbox 指令會失敗，agent 自己重試」[PI-sec] | **最大差距**：三者的 daemon 擁有 process，手機斷線不影響 `npm run build`。pi-mobile 的長指令會隨 Wi‑Fi 抖動一起死 |
| 結果不明的處理 | teardown 統一回 `pi-env connection lost`；不區分「送出前斷」與「送出後斷」[PI-conn] | T3：mutation 不自動重送；Paseo：確定未送出回錯誤，模糊則保留意圖 |
| 電腦狀態呈現 | 沒有常駐的電腦可達性指示；錯誤出現在工具步驟或 `切換電腦失敗：…` [PI-panel] | T3／Paseo 都有「連線中／重連中／更新中」且與資料新舊分開 |
| 容器準備 | `prepareContainers` 同一次執行只做一次，設定、面板、Bot 共用 [PI-host]；但曾由 `ComputerPicker` 的 render effect 觸發，造成迴圈（已修）[PI-loop] | T3：setup 不能是健康檢查副作用。pi-mobile 的 prepare 仍由 UI effect 啟動 |
| 命令冪等 | 觸發事件 id 成為 `requestId`，pi-durable 去重；送出後才記次數、刪一次性排程、最後 ack [PI-triggers] | 與 T3 receipt 等價 |
| 缺席的排程 | 一次性排程原生端過時 5 秒內補觸發，`fired` 標記避免重複；每日上限 10／30 次 [PI-triggers]；重複排程錯過多次時的語意沒有寫明 | Lody 明寫「只跑最近一次」 |
| 權限／核准 | 2026-10-23 拿掉所有核准，背景寫入直接執行 [PI-triggers] | Lody 的 permission 契約不適用；但「失敗要可見」的部分適用 |
| 配對與撤銷 | 配對碼換 32 bytes 金鑰，Keystore 存；撤銷要在電腦上編輯 `paired.json`，手機移除電腦不通知電腦端 [PI-host-doc][PI-design-sec] | T3 unlink 先提交撤銷再拆外部資源 |
| 一台電腦多支手機 | 直接模式各自連線；容器的 egress bridge 一次只接一支手機 [PI-host-doc] | Paseo／T3 多客戶端是基本 |
| 串流 | 已有：段落 memo、`useSmoothText` 每幀補一點、不做淡入、實色頂欄 [PI-arch] | 與 Paseo 的節奏設計等價，而且是量過的 |
| 側欄 | Base UI Drawer，以建置時 patch 修 overdrag [PI-drawer] | Paseo 的單一位置模型更乾淨，但 pi-mobile 的 patch 已實測 0 px |
| 工作區 | 三個環境都有檔案分頁；電腦有 git 狀態、diff、最近 commit；HTML 在隔離 iframe 預覽、可分享 [PI-features][PI-artifacts] | 沒有 worktree、checkpoint、回退 |
| 診斷 | release 關閉 WebView 偵錯，`run-as` 進不去 [PI-design-sec]；只有 `log.ts` 到 console | 這次容器凍結要靠 CDP；正式版使用者拿不到證據 |
| 能力宣告 | `Platform.native` 逐 plugin 檢查，少了就不裝工具；硬體層還沒做 [PI-cap] | 方向一致 |
| 缺失的電腦 | 選過的電腦被移除時 Bot 不改到別台，工具回錯誤、面板顯示「已移除的電腦」[PI-arch] | 與 T3「不能默默退回另一個環境」一致 |
| 不做 subagent | 2026-10-24 決定不做 subagent／child task [PI-arch] | Paseo／Lody／T3 都有；pi-mobile 的理由（手機任務幾秒到半分鐘）仍成立 |

## 三、分級建議

分級標準：**A** 現在就值得做、與現有架構一致、成本可控；**B** 價值高但要先做設計決定或實測；**C** 有明確需求再做；**D** 不引入，寫明原因以免反覆討論。每項附驗證方式；沒有一項是已完成的。

### A 級

（2026-10-26 全部完成並在 S24 驗證：A1–A5 已推送，A6 改為補文件。）

**A1. 連線遺失時區分「送出前」與「送出後」。**
來源：T3 mutation 不自動重送 [T-conn]；Paseo 確定未送出回錯、模糊保留意圖 [P-lifecycle]。
現況：`StreamConnection.#send` 在寫入前呼叫 `options.onStart`，teardown 對所有 pending 一律 reject 同一個 `lost(...)` [PI-conn]。
建議：pending 記錄「已寫入 socket」；teardown 時已寫入的回 `結果不明：指令可能已在電腦上開始，重做前先確認`，未寫入的維持 `connection lost`。sandbox 描述加一句：結果不明時先檢查（`git log`、`gh pr list`）再重跑。
成本：`stream-connection.ts` 幾十行、提示一句、contract 測試一條。
驗證：contract 測試用假的 `open` 模擬寫入後斷線與寫入前斷線兩種回傳；S24 上對 `gh pr create` 在中途斷 Wi‑Fi，確認 agent 不重複開 PR。

**A2. 電腦狀態階梯，與工具結果分開顯示。**
來源：T3「transport 健康與資料新鮮分開」[T-conn]；Paseo「socket 連上不證明對話最新」[P-sync]。
現況：沒有常駐指示；使用者只能從失敗的工具步驟推測 [PI-panel]。
建議：Bot 面板「電腦」區塊顯示最近一次 `StreamConnection` 事件導出的狀態：未連線／連線中／已連線（session id）／斷線（原因、時間）／容器準備中（進度）。只從事件導出，不另外輪詢；面板關閉時不做任何事。
成本：`StreamConnection` 加事件回呼；`HostSandbox` 轉發；`BotPanel` 一行狀態。
驗證：關掉電腦的 pi-mobile、斷 Tailscale、容器建置中三種情況各截一張圖，確認文字與實際一致；`npm run check`。

**A3. 容器準備由明確動作啟動，不由 render 啟動。**
來源：T3「setup 不能是健康檢查副作用」[T-providers]。
現況：`ComputerPicker` 的 `useEffect` 在 container 被選中時呼叫 `prepare()`；上一輪的迴圈就從這裡來 [PI-loop]。修正後 host 身分穩定，但「打開面板就可能開始建 image」仍在。
建議：prepare 只在三個時機：使用者在設定或面板**選擇**容器、Bot 第一次用到 `env()`（已經如此）、使用者按「重試」。面板打開時只顯示 A2 的狀態。
成本：移動一個 effect；`usePrepare` 改成由事件呼叫。
驗證：打開面板不產生 `/exec`（host log 只記路徑，可對照）；選擇容器才有建置輸出。

**A4. 正式版可分享的診斷記錄。**
來源：Paseo 的 Downloads JSONL 診斷 [P-android]。
現況：release 關閉 DevTools；這次容器凍結在正式版上沒有辦法取得 JS 證據 [PI-design-sec]。`log.ts` 已是結構化事件。
建議：`log` 加一個有上限的環形緩衝（例如 2000 筆或 1 MiB），記連線轉換、runtime 開關、觸發派送、工具呼叫耗時、主執行緒 heartbeat 缺口（`setInterval` 250 ms，>500 ms 記一筆）；設定 › 關於 加「分享診斷記錄」，走現有 `AppsPlugin.share`。不記 payload、金鑰、對話內容；連線識別只記主機名。
成本：`log.ts` 緩衝與 heartbeat、設定頁一個按鈕。
驗證：人為製造一次 render 迴圈（在隔離副本把 A3 改壞）後分享記錄，確認 heartbeat 缺口與 `host.prepare` 事件可見；確認記錄裡沒有 token 字串（grep 金鑰前綴）。

**A5. 移除電腦時撤銷配對金鑰。**
來源：T3 unlink 先提交撤銷 [T-connect]。
現況：`design/security.md` 已列為「還沒處理」：撤銷要在電腦上編輯 `paired.json` [PI-design-sec]。
建議：host 加 `DELETE /pair`（需帶現有金鑰），刪掉 `paired.json` 中該金鑰；手機「移除電腦」時先呼叫它，連不上也照樣移除本機設定並告知「電腦上的配對未撤銷」。
成本：Go 一個 handler 與測試、`HostsGroup` 一次呼叫。
驗證：移除後用舊金鑰打 `/info` 得 401；連不上電腦時移除仍成功且顯示提示。

**A6. 寫明重複排程錯過時的語意。**
來源：Lody「只跑最近一次、最多一個等待」[L-sched]。
現況：一次性排程有 `fired` 與 5 秒補觸發；重複排程在手機關機一整天後會怎樣，`triggers.md` 沒有明寫 [PI-triggers]。
建議：先在 S24 實測（關機跨過兩個排程時間再開機），把實際行為寫進 `design/triggers.md`；若會跑多次，改成只跑最近一次並記錄跳過的次數。
成本：主要是實測；程式改動視結果而定。
驗證：實測紀錄附在文件；contract 測試模擬兩個過期事件只送出一則輸入。

### B 級

**B1. 讓電腦上的指令在手機斷線後活下來。** 研究完成：[long-commands-over-drops.md](long-commands-over-drops.md)。實測換網路與鎖屏都不斷；只有無網路超過 30 秒與 App 被殺會中斷。建議先量發生率，再做電腦端代為維持 pi-env 的方案。
來源：三者的 daemon 都擁有 process [T-overview][P-lifecycle]。
現況：`/env` 的 pi-env 與 `/exec` 的指令都綁在 WebSocket 的 process group，斷線即 SIGTERM [PI-host-go]。這是「從手機完成開發」最實際的障礙：`npm ci`、`gradle`、長測試會隨鎖屏斷網一起死。
為什麼是 B：pi-env 1.4.0 的 README 沒有提到 session 重新附著 [PI-env]；要嘛 host 端保留 pi-env process 一段寬限期並允許以 token 重新附著（要改 `StreamConnection` 的 session 語意與 pi-env 的 frame 重放），要嘛只對 `bash` 做：host 端把指令交給 `setsid`/`nohup` 加結果檔，手機重連後取回。兩條路都動到協定，且與「連線結束就收掉所有程序」這個刻意的清理設計衝突（孤兒程序曾實測留下 7 個）。
建議：先做研究題：(1) pi-env serve 是否有或能加 reattach；(2) 寬限期與清理的取捨（例如 60 秒內重連接回，否則照舊殺掉）；(3) 配合 A1，重連後的結果取回要能對上原 request id。寫成 `docs/research/`，再決定。
驗證（若實作）：S24 上跑 90 秒的指令，中途關 Wi‑Fi 20 秒，指令完成且輸出回到同一個工具步驟；超過寬限期則程序被清掉、步驟顯示結果不明。

**B2. 容器 egress bridge 一支手機一條。**
來源：Paseo／T3 多客戶端 [P-perm][T-auth]。
現況：`computer-host.md` 已列：bridge 一次只接一支手機，誰拿到 bridge 誰的憑證生效 [PI-host-doc]。
為什麼是 B：要改 `bridge.py` 的連線模型與 token 請求的路由（按容器或按 Bot 資料夾分辨是哪支手機），牽涉憑證隔離，不能只改一端。
驗證：兩支手機（或手機＋模擬器）同時用容器，各自 `gh api user` 回各自帳號。

**B3. 回到前景時 probe，而不是等 30 秒靜默。** 實測後不做：工作中的連線在鎖屏與換網路時都沒斷；閒置時逾時是預期，下次呼叫重連即可（見 long-commands-over-drops.md）。
來源：T3 回到前景 probe、長背景直接換 session [T-conn]；Paseo 前景 probe 三秒 [P-sync]。
現況：ping 每 5 秒、30 秒無回應 teardown；頁面被 Chromium 凍結時計時器停住，回到前景後 `lastSeen` 已過期，第一個 ping tick 會 teardown [PI-conn]——對已經死掉的 socket 這是對的，對還活著的 socket 是多餘的一次重連。
為什麼是 B：要先量：App 從背景回來時 socket 多常還活著？若多半已死（Android 省電常如此），現況就是對的，只需把「回到前景」當成立即 probe 的時機，而不是等 tick。量完再決定。
驗證：S24 背景 1、5、15 分鐘各十次，記錄回到前景時 socket 狀態與第一次工具呼叫的延遲。

**B4. 電腦端能力宣告。**
來源：T3 能力協商 [T-overview]；Lody `_meta` 逐項 [L-acp]。
現況：APK 與 host 同一 commit 發布，daemon 由手機帶過去；`/info` 回 engines 與 daemons，錯誤訊息說「可能要更新」[PI-host]。
為什麼是 B：現在配對發布讓問題很小；一旦 B1 或 A5 讓 host 端 API 增加，舊 host 配新 App 就會出現。到那時 `/info` 加 `features: string[]`，手機依此顯示「電腦上的 pi-mobile 需要更新才能…」，而不是一般錯誤。
驗證：舊 host 二進位配新 App，功能缺失時訊息明確。

### C 級

**C1. 刪除容器資料夾前列出未提交的變更。**
來源：Lody 回收 worktree 前先 commit 備份 [L-worktrees]。
現況：清空資料夾／刪除 Bot 直接 `rm -rf` [PI-sandbox]。
條件：使用者開始在容器裡做真正的專案工作後。做法：刪除前跑 `git status --porcelain` 列出有變更的 repo，確認框列出來；不自動 commit（那會改寫使用者的 repo 歷史）。

**C2. 直接模式的「這一輪改了什麼」。**
來源：T3 隱藏 ref 的 checkpoint [T-overview]。
現況：直接模式從家目錄操作使用者的檔案，沒有回退 [PI-host]。
條件：直接模式用於真實專案而非一次性查詢時。先做唯讀：每輪結束記 `git status` 差異在步驟卡片；不做自動回退（T3 也要求 provider 能回退對話才允許）。

**C3. 側欄改成單一位置模型。**
來源：Paseo mobile panels [P-panels]。
現況：Base UI Drawer 加建置時 patch，實測 0 px 過拉 [PI-drawer]。
條件：下次需要改手勢或升級 Base UI 讓 patch 失效時。屆時用「一個正規化位置 + revision 所有權」重寫，而不是再加 patch。
2026-10-28 已完成：側欄改用自己的手勢，位置是一個 0 到 1 的數字，一直由程式擁有：拖動時跟著手指，放手後用 `requestAnimationFrame` 帶到 0 或 1；新的拖動或開關先停掉正在跑的，從當下的位置接手。見 [iphone.md](iphone.md)。

**C4. 配對 scope。**
來源：T3 scope、Paseo 語意權限 [T-auth][P-perm]。
現況：配對金鑰一把、全部權限 [PI-host-doc]。
條件：出現第二支手機、或想讓某台電腦只能唯讀（看檔案、不執行）。注意 Paseo 的提醒：agent 與終端都能執行程式，分開寫入權限會宣稱做不到的隔離；pi-mobile 的對應是 `/env` 與 `/exec` 權限相同，只有「唯讀」是真的邊界。

**C5. 硬體層的能力偵測。**
來源：與 `design/capabilities.md` 第二層相同 [PI-cap]；Lody／T3 的「缺少就明確」原則支持它。
條件：已在計畫中；不因本研究提前。

### D 級（不引入）

**D1. Relay／雲端帳號／推播基礎設施。** Tailscale 已滿足「不開 port、同帳號」；pi-mobile 的 agent 在手機上，「App 不連線也能收通知」這個推播的主要價值不存在（通知由手機自己發）。只有當 Tailscale onboarding 成為實際障礙時再看 Paseo 的 QR 配對（它仍需要 daemon 向 relay 連出，且 E2EE 有相容性條件 [P-relay]）。

**D2. ACP／外部 provider。** pi-mobile 不是 agent 控制面板；要控制 Claude Code／Codex 的 session 是另一個產品。Lody 的能力表顯示 Pi adapter 的 resume／fork／MCP 並非全部支援 [L-acp]，接 ACP 不會自動得到 pi 的全部功能。

**D3. subagent／多 agent 協調。** 已有決定與量測（三件事 300 秒、多一份上下文、還錯一題）[PI-arch]。Paseo／Lody 的 orchestration 是給幾分鐘到幾小時的電腦任務；pi-mobile 的任務量級不同。若 B1 讓長指令可靠了，再重新評估，不是現在。

**D4. 團隊共享、CRDT、E2EE 同步。** 單人多 Bot 不是多人共編。Lody 自己的 E2EE 也尚未接入產品 [L-readme]。

**D5. worktree 作為一級概念。** 一個 Bot 一條對話一個資料夾已經是隔離；兩個 Bot 同時改同一個 repo 時各自 clone 就是 worktree 的等價物。要並行開發請用兩個 Bot，寫進使用說明即可。

**D6. 以版本號判斷功能。** 三者都反對；pi-mobile 若做 B4 要用能力宣告，不比對版本字串。

**D7. 重新引入核准框。** 2026-10-23 已拿掉；Lody 的 permission 契約設計得很好，但它解的是「agent 要問人」，pi-mobile 選擇的是「給工具組就是授權」。保留這個決定；A1 的「結果不明」提示是不同的問題。

## 四、建議的順序

1. **A1 + A2**（一起做）：連線事件化，既給狀態顯示，也給「送出前／後」判斷。
2. **A3**：把 prepare 從 render 搬走；與剛修的迴圈同一區域，趁熟。
3. **A4**：診斷記錄；下次正式版出問題不再靠 CDP。
4. **A5、A6**：各半天，補文件已列的缺口。
5. **B1 研究**：這是「從手機完成開發」真正的門檻；研究完再決定 B3、B4。

每一步都照 AGENTS.md：contract 測試走 `Platform` seam、`npm run check`、S24 實測前後對照。以上沒有一項已開始。

## 來源

T3 Code（`5b35402623d7d1d88eaa472807272a6c2e78012a`）
- [T-overview]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/overview.md
- [T-remote]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/remote.md
- [T-conn]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/connection-runtime.md ；程式碼 `packages/client-runtime/src/connection/supervisor.ts`、`packages/client-runtime/src/rpc/client.ts`
- [T-sink]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/apps/server/src/orchestration-v2/EventSink.ts
- [T-providers]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/providers.md
- [T-auth]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/environment-auth.md
- [T-connect]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/internals/t3-connect.md
- [T-handoff]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/portable-handoffs.md
- [T-composer]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/composer.md
- [T-notify]: https://github.com/pingdotgg/t3code/blob/5b35402623d7d1d88eaa472807272a6c2e78012a/docs/user/mobile-notifications.md

Lody（`91fa467a205c71966b715356a7bf04b501fbb199`）
- [L-readme]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/README.md
- [L-boundary]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/AGENTS.md
- [L-acp]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(migrating)/acp-feature-support.mdx
- [L-caps]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/apps/cli/src/agent/acp-capability-normalization.ts
- [L-concepts]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(core-concepts)/concepts.mdx
- [L-roles]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(guides)/agent-roles.mdx
- [L-catalog]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/.agents/docs/workspace-catalog-durability.md
- [L-handoff]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(guides)/session-handoff.mdx
- [L-team]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(guides)/team.mdx
- [L-live]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/.agents/docs/sessions-live-status.md
- [L-perm]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/specs/permission-requests.md
- [L-history]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/specs/session-history-writes.md
- [L-worktrees]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(core-concepts)/worktrees.mdx
- [L-sched]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/site-docs/content/docs/en/(guides)/scheduled-tasks.mdx
- [L-failure]: https://github.com/LodyAI/Lody/blob/91fa467a205c71966b715356a7bf04b501fbb199/.agents/docs/failure-containment.md

Paseo（`d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed`）
- [P-lifecycle]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/agent-lifecycle.md
- [P-sync]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/timeline-sync.md
- [P-sync-code]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/packages/app/src/timeline/viewed-timeline-sync.ts
- [P-stream]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/agent-stream-performance.md
- [P-panels]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/mobile-panels.md
- [P-notify]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/notifications.md
- [P-perm]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/permissions.md
- [P-relay]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/relay-endpoint-security.md
- [P-data]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/data-model.md
- [P-android]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/android.md
- [P-product]: https://github.com/getpaseo/paseo/blob/d0fd2e532059eeaec4c9e9e510fd65e1a3c6e1ed/docs/product.md

pi-mobile（`1783b2a3588a2ed666f1b814b5e31c19bce6e6be`）
- [PI-arch]: ../architecture.md
- [PI-features]: ../features.md
- [PI-sec]: ../security.md
- [PI-design-sec]: ../design/security.md
- [PI-host-doc]: ../design/computer-host.md
- [PI-artifacts]: ../design/artifacts.md
- [PI-cap]: ../design/capabilities.md
- [PI-triggers]: ../design/triggers.md ；`src/agent/triggers.ts`
- [PI-conn]: `src/agent/sandbox/stream-connection.ts`
- [PI-host]: `src/agent/sandbox/host.ts`
- [PI-sandbox]: `src/agent/sandbox/sandbox.ts`
- [PI-panel]: `src/app/BotPanel.tsx`
- [PI-host-go]: `host/main.go`（`Setpgid`、SIGTERM 後 2 秒 SIGKILL、`WaitDelay`）
- [PI-env]: `node_modules/@earendil-works/pi-env/README.md`（1.4.0）
- [PI-loop]: container-prepare-loop.md
- [PI-drawer]: side-drawer-bounds/README.md
