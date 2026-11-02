# P3：結構整理的第三批

狀態：2026-11-02 定案（見〈決定〉）；三個 pi agent 讀程式審查過，修正了下面幾處事實。P0 到 P2 已做完；這批是範圍較大的結構改動，照 `.pi/skills/architect` 先定形狀再寫程式。數字都是 `git grep` 和腳本算出來的。

## 一、工具宣告的原生能力（`needs`）和實際呼叫的不一致

### 現況

- 63 個 `defineAppTool`；工具檔直接 `import` 原生 plugin 物件的有 18 個檔、22 處，呼叫什麼不受 `needs` 限制。
- 稽核腳本逐一比對工具本體裡的呼叫和 `needs`：
  - `use_browser` 只宣告 `Browser.act`，實際還呼叫 `Browser.read`、`newTab`、`tabs`、`closeTab`。iOS 若只移植 `read`、`act`，工具會出現在 iPhone 上，用到開新分頁時才在任務中途失敗。
  - `create_schedule` 呼叫 `Notifications.status`，沒有宣告。
  - 其餘的「宣告了卻沒在工具本體呼叫」都是經過 helper（`requireAccess`、位置 helper），是正確的。

### 候選

| | 做法 | 擋得住什麼 | 代價 |
|---|---|---|---|
| A1 注入 | `execute` 多收一個只含宣告方法的 `native` 物件；工具檔不准 import plugin 物件（code-rules）；helper 也改成收這個物件 | 呼叫沒宣告的方法編譯不過；工具可以在 node 測試裡給假的原生 | 63 個工具和它們的 helper 都要改簽名，一次大 diff |
| A2 檢查 | `test/tools-node.ts` 用 AST 比對工具本體的直接呼叫是否在 `needs` 裡；「有就用、沒有也行」的呼叫（`native.implements` 先檢查的）另外宣告成 `optional` | 直接呼叫的不一致（上面兩個都會被抓到） | 經過 helper 的呼叫看不到 |

### 建議

A2 先做，修掉那兩個不一致。A1 的真正價值是讓工具能寫 node 測試；等下一次修工具卻寫不了測試時再做，那時有具體的理由。

## 二、排程文件（`TriggerDoc`）有好幾個寫入者

### 現況

- 8 處寫入，分在 3 個檔：`src/triggers/runs.ts`（4）、`src/triggers/tool.ts`（2）、`src/computer-agents/tool.ts`（2，「等 agent 做完」自己組一筆 `Trigger` 直接寫入，再呼叫 `triggers.changed()`）。
- 下一個要「做完叫醒我」的功能照 `computer-agents` 抄，漏掉 `changed()` 就不會排上原生鬧鐘，Bot 不會被叫醒，也不會有錯誤。
- 執行有兩條路，規則已經不一樣：

| | 一般排程 `run()` | 事項 `#runItem()` |
|---|---|---|
| 手動執行受每日上限 | 不受 | 受 |
| 超過上限 | 記一筆失敗和原因 | 不記錄，只 `sync()` |
| 同一事件重複送達 | `sync()`，回傳原本的對話 | 直接回 `undefined` |

### 候選

| | 做法 | 代價 |
|---|---|---|
| B1 單一主人 | `src/triggers/` 提供寫入 API（`add`、`removeWhere`），內部負責 `changed()`；code-rules 限制只有 `src/triggers/` 能碰 `TriggerDoc`；兩條執行路徑共用一個「去重、上限、記錄」的核心 | 要先定上面那張表每一列要哪一種 |
| B2 只加限制 | `computer-agents` 改呼叫 API、加 code-rules；兩條路徑維持現狀 | 規則的分岔還在，第三個來源會再抄出第三套 |

### 建議

B1。

## 三、可預期的失敗用丟例外表達

### 現況

- `createBot`（最多 12 個）、`removeBot`（至少留一個）、記憶字數上限、Bot 名字和工作說明的驗證，用 `throw` 加中文訊息；UI 只能把字串塞進通用提示，不能依原因停用按鈕或把錯誤放在動作旁邊（AGENTS.md：錯誤放在動作發生的地方，不用 toast）。
- 電腦配對（`src/agent/sandbox/host.ts`）的 401、403、410、422、連不到、不在 Tailscale，全是 `throw`。
- 這些是 runtime 的公開 API，新方法會照抄。

### 候選

| | 做法 | 代價 |
|---|---|---|
| C1 回傳 union | 這些方法回傳 `{ ok: true } \| { ok: false; reason: "limit" \| "last_bot" \| … }`；UI 依原因顯示在動作旁（例如超過上限時「新增 Bot」直接停用）；code-rules 擋 `src/agent/` 裡（工具以外）帶中文訊息的 `throw new Error` | runtime、host 和用到它們的畫面都要改 |
| C2 只擋新增 | 不改現有的，code-rules 只在數量增加時失敗 | 現有的例子還在被抄 |

### 建議

C1，分兩個 commit：Bot 管理一個、電腦配對一個。

## 四、MCP 工具名稱可能撞到內建工具

### 現況

- MCP 工具叫 `${server.id}_${name}`，前綴寫在 3 處（`mcp.ts:100` 命名、`:314` 給模型的說明、`:377` 收回權限時的前綴）。
- pi-durable 依名稱合併工具，後裝的蓋掉先裝的，不報錯；MCP 在內建之後安裝。連一個叫 Web、有 `fetch` 工具的服務，`web_fetch` 就被換掉。
- 收回權限用前綴刪掉已載入的工具：服務 id 是 `phone` 時，`phone_read_as_user` 也會被刪。
- `serverId` 只避開其他 MCP 的 id，不避開內建名稱。

### 候選

| | 做法 |
|---|---|
| D1 | 名稱和前綴由同一個函式產生；新的 `serverId` 避開內建工具會用到的前綴（從 catalog 推導，例如 `web`、`phone`、`computer`）。已存的 id 存在每個 Bot 的設定裡，不改 |
| D2 | MCP 工具一律加固定前綴（`mcp_<id>_<name>`）。會改掉現有工具名，等於刪舊加新，已載入的會失效 |

### 建議

D1。

## 五、還靠手動同步的清單

| | 清單 | 做法 |
|---|---|---|
| E1 | `gh` 子指令：switch、錯誤訊息、系統提示各寫一次 | 一張 `GH_COMMANDS` 表，三處都從它推導 |
| E2 | 手機畫面和瀏覽器的 step 動作、按鍵：工具 schema、說明、錯誤訊息、Kotlin 各寫一次 | `keys` 改成 `oneOf(KEYS)`；說明和錯誤從清單產生；`plugins-node` 比對 TS 和 Kotlin 的動作、按鍵（同排程種類的做法） |
| E3 | 自動化紀錄的 `kind`、`delivery`、`on` 存成字串；圖示靠比對 Kotlin 寫的中文描述 | 改成 `oneOf`；事項回覆的紀錄補上 `on`；圖示只看 `on` |
| E4 | 訊息裡哪些區塊不給使用者看，有三種寫法（複製、預覽、畫面） | `src/agent/entries.ts` 一個分類函式，三處都用它 |
| E5 | `docs/tools.md`〈怎麼管理〉的表手寫了直接提供和需要時載入的工具名 | 改成指向工具總圖的 ＊、† |
| E6 | 原生：勿擾設定後不讀回、發通知有三條路 | `setDnd` 回傳讀回的狀態；通知收成一個先檢查能不能顯示的入口 |
| E7 | 設定頁用 optional props 的組合當模式，一般模式的 `onSave` 是死路，首次設定存檔失敗沒人接 | props 改成 `{ mode: "setup" … } \| { mode: "app" … }`，存檔錯誤顯示在按鈕旁 |

E1 到E5 是小改；E6 動原生，E7 動設定頁。

## 審查後的更正

- 二的比較表只列了 3 種差異，實際有 9 種（Bot 已刪、篩選略過、送出失敗、放棄、紀錄的 `on`、寫入前去重、過期的單次）。「手動執行受上限」那列走不到：事項沒有手動執行的入口。
- **事項超過上限會每 5 秒喚醒一次，最長 6 小時**（讀碼推論）：超過上限時 `#runItem` 沒把這次到期記成處理過，`nextAt` 留在過去；原生把 6 小時內錯過的單次排在 5 秒後補響（`Schedule.kt` `MISSED_GRACE_MS`、`LATE_FIRE_MS`），TS 又原樣送回。
- 三的前提大多不成立：刪最後一個 Bot、名字、記憶字數、電腦配對的錯誤，UI 已經在動作旁邊處理；只有 12 個 Bot 的上限沒先檢查。
- 四：服務清單存在全域（`pi-mobile.mcp-servers`），每個 Bot 存的是 `mcp-<id>` 和已載入的工具名；新增服務時也會先收回權限（`mcp.ts:385`），加一個 GitHub 的 MCP 就會卸下每個 Bot 已載入的 `github_*`。
- E3 照原案會讓舊的自動化紀錄從畫面消失（存在對話裡的舊 entry 驗不過）；E2 改 `oneOf` 會改工具介面。

## 決定

| | 決定 |
|---|---|
| 一 | 補齊 `use_browser` 的 `needs`；`create_schedule` 那些只在某些情況才用的呼叫改成先 `native.implements`。`test/tools-node.ts` 檢查：工具檔裡每個原生呼叫都在 `needs` 裡，或被 `native.implements` 擋住。不加 `optional` 欄位 |
| 二 | 先修循環：事項超過上限時延到明天同一時間，並寫在該 Bot 的對話結尾。再把「叫醒 Bot」合成一份（去重、上限、記錄、送出），排程和事項只是兩個來源，資料各自保留；事項的失敗也寫在對話結尾。`TriggerDoc`、`ItemDoc` 只能由擁有者寫入（code-rules） |
| 三 | 不做 C1。12 個 Bot 時停用「新增 Bot」 |
| 四 | 收回權限改用確切的工具名；和內建同名的 MCP 工具不載入，設定 › MCP 那列註明；新的服務 id 避開內建工具用到的前綴（從 catalog 推導） |
| 五 | 先 E7，再 E1、E5、E2（說明和錯誤從清單產生，不改 schema）、E3（只補 `on`）；E4 先核對；E6 之後 |

## 原本的問題（已決定）

1. 一：A2（先檢查，便宜）還是 A1（注入，大改）？建議 A2。
2. 二：兩條執行路徑統一成哪一種？
   - 手動執行受不受每日上限？建議**不受**：使用者親手按的不該被擋。
   - 超過上限要不要留一筆失敗紀錄？建議**要**：自動化頁看得到為什麼沒跑。
   - 同一事件重複送達：建議統一成「不再跑，回傳原本的對話」。
3. 三：C1 會改到「新增 Bot」「刪除 Bot」「記憶」「電腦配對」幾個畫面的錯誤顯示位置，可以嗎？
4. 五：E1–E7 全做，還是只做 E1–E5，E6、E7 之後再說？

## 對未來的影響

- 清掉：工具宣告和呼叫不一致、排程文件多個寫入者、兩套執行規則、runtime 用例外表達預期結果、MCP 名稱撞內建、七份手動同步的清單。
- 新增：`needs` 多一個 `optional` 欄位；`src/triggers/` 多一組寫入 API。
- 留下：A1（工具改用注入的原生能力）等到第一次需要替工具寫 node 測試時。

## 第一步

使用者決定後，從二（B1）開始：它的失敗最安靜（Bot 不會被叫醒、也沒有錯誤）。
