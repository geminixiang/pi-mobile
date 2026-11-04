# 地基檢查

檢查日期：2026-11-04，範圍是 commit `db59389`。方法是 pstack 的 swarm 和 principle 系列：切成資料、邊界、生命週期、測試、結構五片，各自獨立查，再彙整。

證據標記：
- **〔跑過〕**：寫了重現腳本或實際執行過。
- **〔模擬〕**：用時鐘或假環境跑過，沒有在真機上跑。
- **〔讀碼〕**：讀過程式，註明位置，沒有執行。
- **〔推測〕**：沒有驗證。

原生程式碼都只讀過，檢查期間沒有碰手機。

## 結論

地基能承重，不用重做。五片都判定有問題，沒有一片建議重做。問題集中在三處：排程錯過或重複時怎麼辦、沒有人在場時怎麼辦、防護網的破洞。

## 穩固的部分

- **資料**：寫入是原子的，事件有去重；1.4.0 跑到一半被殺的資料，1.5.0 能接手。〔跑過〕
- **電腦端**：`go test -race` 通過，沒有 goroutine 洩漏。〔跑過〕
- **型別**：`src` 只有 4 個 `as`，`parse.ts` 是單一入口，`typeboxArgs` 沒有藏真錯誤。〔讀碼〕
- **其他**：MCP 連線的世代管理、工具 catalog、檢查體系本身都紮實。故意弄壞時抓到的 40 處，都由名稱正確的測試抓到。〔跑過〕

## 第一優先：真實使用會出事

| # | 問題 | 情境 | 位置 | 證據 |
|---|---|---|---|---|
| 1 | 排程補跑 | 每天的排程錯過三天，開 App 時連跑三次。`docs/design/triggers.md` 卻說不補跑 | `TriggerReceiver.fire`、`src/triggers/events.ts` | 〔跑過〕佇列；〔讀碼〕原生 |
| 2 | 卡片在沒人時永遠等 | 排程回合遇到確認卡，對話一直忙碌，後面的排程排隊，wake lock 一直續約 | `src/interaction/forms.ts` `ask` | 〔跑過〕 |
| 3 | MCP session 過期後永久失敗 | 伺服器重啟後工具一直報錯，狀態卻顯示 ready | `src/agent/mcp.ts` | 〔跑過〕 |
| 4 | iOS 日曆第一次允許必失敗 | `pluginMethods` 沒列 `requestPermissions`，回 `{}`，閘門判定被拒絕 | `src/interaction/phone-permissions.ts` | 〔讀碼〕 |
| 5 | Android 只給大約位置時 `get_location` 被擋 | 原生 `anyLocation()` 接受任一權限，閘門的判斷不同 | `src/interaction/permissions.ts` | 〔讀碼〕 |
| 6 | 一筆 null 毀掉整份清單 | 必填欄位收到 null，整份日曆、通話、簡訊草稿、相片或聯絡人讀取失敗 | `CalendarPlugin.java:125` 等 | 〔跑過〕解析；〔推測〕手機上是否出現 null |
| 7 | 逾期事項永遠不叫醒 | 超過 6 小時就不再叫醒 Bot，等待中的事項連小工具都不顯示 | `Schedule.kt` `MISSED_GRACE_MS` | 〔讀碼〕 |
| 8 | 頁面凍結超過 30 秒，電腦端 session 被殺（真機沒有重現，見「S24 上的驗證」） | pi-env 拆除時以 close(1000) 收尾，電腦端當成結束，保留期用不到。一個 close 有兩種意思，也不在 `host/protocol.json` | `src/agent/sandbox/`、`host/held.go` | 〔模擬〕 |

第 2、4、5 項來自 `src/interaction/` 最近的工作。

## 其他資料問題

- 一次性排程被每日上限吃掉，事項則是延後（`src/triggers/runs.ts`）。
- 被中斷的寫入工具交給模型判斷；`replay` 信任伺服器的 `readOnlyHint`。
- `unattended` 只在記憶體，重啟後遺失。
- 移除 Bot 中途被殺，排程和事項留著（`triggers.removeBot` 不在 `#finishRemoval`）。
- 匯入的試算表在移除 Bot 後留著，對話框卻說已刪除。
- 一筆壞掉的舊排程讓整個系統停擺（`migrate` 的 `valueOrThrow`）。
- 小工具的資料可能過期。

## 其他邊界問題

- iOS 的 `note_item` 承諾會叫醒，`runs.ts` 卻跳過同步。
- Android 的 `sql` 不檢查多語句，iOS 拒絕（`DatabasePlugin.swift:87`）。
- `Type.Number` 對上原生的 `getInt`，目前沒出事。
- 根源：`test/plugins-node.ts` 只比方法名稱，不比欄位。

## 其他生命週期問題

- 忽略 signal 的工具會擋住 Stop 和 `close()`，約 75 秒。
- 重複 attach 會讓 frame 重複（`resumable-socket.ts`）。
- 離線狀態回到前景不會自癒（`network.ts`）。
- `#stateless` 把一次失敗的 discover 快取到重連。
- `ResumableSocket.connect` 洩漏計時器。
- 開啟失敗留下殭屍 runtime；冷啟動開兩次；立即關閉要等 30 秒。
- 移除 Bot 不是冪等的；閘門共用一個 promise。

## 測試

跑了 38 次完整 `npm run check`，3 份失敗紀錄，來自兩個偶發失敗，都是測試本身的問題。故意弄壞 75 處，抓到 40 處，35 處沒發現。第二輪是對著弱點挑的，比率不代表全貌。

沒發現的地方：

- 電腦端的配對金鑰和 Origin（`host/main.go`，測試繞過 `guard`）。
- 排程回合代答電腦 agent 的防線（`src/computer-agents/tool.ts:130`）。
- 日曆的隱藏帳號和唯讀設定（4 處全沒抓到）。
- runtime 的重試接線（`runtime.ts:247`）。
- MCP 的重放旗標（`mcp.ts:320`）。
- `editMemory` 的替換路徑。
- `Schedule.kt` 和送給原生的內容。
- 事項的擁有權和清除。
- 表單的中止和略過。
- 憑證模組，沒有函式被執行過。
- 續接的放棄路徑。

另外，215 個 `src` 檔案有 80 個從未被載入，47 個 `.tsx` 覆蓋率為 0，原生沒有測試。`AGENTS.md` 有 10 條規則能被繞過，例如 `.catch(() => null)`、Kotlin 讀錯欄位名稱。

## 結構

- 權限有兩個擁有者（第 4、5 項的根源），`phone-permissions.ts` 沒有測試。
- `App.tsx` 有 8 個互相牽連的畫面狀態，沒有 reducer。
- 卡片有四個資料來源，新增一張要動 13–16 個檔案，`FormsDoc`、`ResultsDoc` 應該合併。
- `TOOL_NAMES`、`phoneLabel` 大半用不到，`TOOL_DOING` 沒有覆蓋檢查。
- `styles.css` 是最常改動的檔案，有 3 個 class 已經沒人用。
- 帳號清單要改五個地方；沒有分層檢查；用中文字串當邏輯；26 個沒用到的 `Toolset.hint`。
- 文件過期：`architecture.md` 少 3 個功能資料夾，`computer-agents.md` 還寫未實作，量測表是舊的。

## 要決定的

- **資料只有一份，升級只能往前**：沒有備份或匯出，`allowBackup=false`。下一版帶 pi-durable 1.5.0 後回不去 0.15.0。
- **對話只增不減**：截圖永久留著，壓縮和重置都不會變小。

## 順序

1. 補防護網：修兩個偶發失敗，push 時跑 CI。
2. 訂兩條規則：
   - 一次該發生的事遇到錯過、重複、撞上限時怎麼辦，解第 1、7 項。
   - 現在有沒有人在只由一個地方回答，解第 2 項。
3. 修第 3～6 項，第 6 項要先確認手機上會不會出現 null；之後上真機驗第 8 項。
4. 補安全相關的測試：配對金鑰、代答防線、日曆隱私、MCP 重放。
5. 決定備份和資料保留，再發下一版。
6. 結構整理，碰到相關功能時一起做。

## 第 1 步的紀錄

**`test/bash/patches.ts`**：`writeFileSync` 先截斷再寫，另一個檢查此時讀到空檔，匯入成功但沒有 `Bash`。改成寫到暫存檔再改名。一邊重寫一邊匯入，舊做法 500 次失敗 424 次，新做法 258 次失敗 0 次。〔跑過〕一般的並行執行重現不了：舊程式 198 次沒有失敗。

**`host/held_test.go`**：失敗紀錄裡測試 0.06 秒就結束，比 400 毫秒的保留期還短，可見等待消失的迴圈看到一次假的 0，程序其實還在。現在保留期過後才開始看。短暫的 0 從哪來沒有查清楚：取樣 150 次登入 shell 啟動都沒看到，舊測試在負載下跑 200 輪也沒重現，所以這個修正沒有失敗的前後對照。新測試在同樣負載下跑 200 輪沒有失敗；拿掉保留期後的 kill，它照樣失敗。〔跑過〕

`.github/workflows/check.yml` 讓 push 到 main 和 PR 都跑 `npm run check`。

## 第 2 步的紀錄

**一次該發生的事**：鬧鐘響了但 pi 不在時，每個排程只跑最新一次，對話裡留一句錯過幾次（`latestAlarms`）。事項逾期多久都還欠著，下次 App 啟動就叫醒 Bot（`schedulesOf`）。一次性排程撞到每日上限時延到隔天，不再消失。

**現在有沒有人在**：由 `Forms.ask` 回答。排程回合不出卡，立刻回 cancel，對話留下「沒有人在，沒有做」。使用者自己開始的回合照常等，App 不在前面時發通知。權限閘門不再自己判斷前景。

拿掉任一修正，對應的測試都會失敗。〔跑過〕都沒有上機驗證。

還沒解決：
- `unattended` 只在記憶體。排程回合跑到一半 App 重啟，接手後會當成有人，卡片又會一直等。
- 手機開機但 App 沒開時，超過 6 小時的事項不會叫醒。要解決得改原生端。
- 等待中的事項仍不上小工具，`test/items.ts` 明確要求這樣，要改得先決定。

## 第 3 步的紀錄

- **MCP session 過期**：呼叫收到 `McpSessionExpiredError` 時丟掉舊連線，重連一次再送。伺服器回 404 代表這次呼叫沒有執行，所以寫入工具也能重送。假伺服器的測試裡工具只執行一次。〔跑過〕
- **iOS 日曆**：`CalendarPlugin.swift` 補上 `requestPermissions`。這台 Mac 沒有 Xcode，Swift 沒有編譯過，也沒上 iPhone。`test/plugins-node.ts` 現在要求回報權限的 iOS plugin 也要能請求。
- **Android 大約位置**：`PhonePlugin` 覆寫 `getPermissionStates`，和 `anyLocation()` 同一個判斷。模擬器上收回精確位置、只留大約位置：舊版回 `prompt`，新版回 `granted`。〔跑過〕
- **null 毀清單**：確實會發生。模擬器的日曆寫入一筆沒標題的事件，資料庫存 `NULL`，舊版的結果少了 `title` 鍵，新版回空字串。〔跑過〕其他欄位用同樣改法，只驗過日曆。`test/plugins-node.ts` 現在禁止 Java 把 cursor 字串直接放進結果，但抓不到先存進變數的寫法。

第 8 項（頁面凍結）的真機結果見下一節。

## S24 上的驗證

**第 8 項沒有重現，先不修。** S24 透過 `env.exec` 在電腦上跑 `sleep`，然後：
- 用 busy loop 擋住頁面 10 秒、40 秒。
- 用 `am freeze` 真的凍結 WebView renderer 和 app 程序 40 秒、40 秒、75 秒。後兩次在頁面裡量到計時器中斷 40.9 秒、75.9 秒。

五次之後電腦上的指令都還在，呼叫也沒被拒絕。〔跑過〕時鐘模擬假設計時器比積壓的訊息先跑，這五次都沒發生。計時器和訊息的先後順序沒有保證，所以只能說少見，不能說不會發生。斷網和凍結同時發生的情況沒有測。

**第 6 項在真實資料上會出事。** 在舊版上只統計缺欄位的筆數，沒有讀內容：500 張相片有 9 張沒有 `album`，所以這支手機上 `Photos.search` 只要範圍碰到這些相片就會整個失敗。〔跑過〕5,364 筆事件、23 個日曆、229 筆通話、500 則簡訊、148 位聯絡人都沒有缺。S24 還沒裝修正後的版本，相片的修正沒有在它上面驗過。

## 第 4 步的紀錄

補了 13 個之前弄壞也沒人發現的地方，每一處重新弄壞後都有測試失敗。〔跑過〕這些測試沒有抓到新的產品問題，原本的程式都是對的。

- **電腦端**（`host/guard_test.go`）：沒有配對金鑰、外來網頁的 Origin、別人的裝置都進不去，`pairing.json` 只有擁有者讀得到。`owner` 改成變數，測試才能走真的 `guard`。
- **代答防線**（`test/contracts/computer-agents.ts`）：排程回合不能代答，也碰不到電腦。
- **日曆隱私**（`test/contracts/calendar.ts`）：隱藏帳號讀不到也寫不到，共用日曆要設定開啟，未開放寫入的日曆不能新增或刪除。`createCalendarExtension` 多一個 `store` 參數，預設是原生的 `Calendar`。
- **MCP 重放**：只有服務標為唯讀的工具才會在重啟後重跑。
- **表單**：停止回合會結束卡片，打字只略過這個對話的卡片。

沒有補的：記憶替換、`Schedule.kt`、事項擁有權、憑證模組、續接的放棄路徑、runtime 重試接線。
