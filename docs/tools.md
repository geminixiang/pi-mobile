# 工具與 context

Bot 的每次請求都帶著它能用的工具說明（名稱、描述、參數 schema）。工具越多，每次請求越大，模型也越容易選錯。這份文件記錄工具怎麼交給模型、各佔多少，以及新工具上線前要做的量測。

## 怎麼管理

**開關**由使用者在 Bot 面板決定（`src/agent/toolsets.ts`）：
- 內建工具預設開啟。
- 連接的服務（MCP）預設關閉，要在設定 › MCP 或 Bot 面板裡給特定的 Bot。
- 程式模式、記憶、附件、skills、排程一律開啟，不列在面板上。

**模型怎麼拿到工具**由每個工具決定（`src/agent/catalog.ts` 的 `withReach`），使用者不用管。從 2026-10-23 起以程式模式為主：

| 方式 | 哪些工具 | 每次請求帶什麼 |
|---|---|---|
| **直接提供** | `codemode`、`bash`、`read`、`write`、`edit`、`update_memory`、`tool_search` | 完整定義 |
| **需要時載入** | 結果是要模型看的圖片：`view_photos`、`read_attachment`、`read_screen`、`use_screen`（腳本拿不到圖片） | 只有名稱（`on-demand.ts`），用 `tool_search` 載入，之後留在那段對話 |
| **只給腳本** | 其他全部，包括 MCP 服務（`callers: ["tools"]`） | codemode 段落裡一行一組：工具名稱和參數名稱（`codemode.ts`）；細節由腳本用 `describeTool(name)` 查 |

- 只給腳本的工具，它們的說明段落也只留模型一定要知道的一句（例：通知不可信、草稿要使用者自己送出）；能從工具名稱看出來的不寫。
- 代價：
  - 模型不認得參數時，要先用一個腳本查 `describeTool`，多一次來回。
  - 需要好幾步的手機任務（例：找附近咖啡店再算步行時間）會拆成幾個腳本，可能比以前慢。

## 介面規範

工具的介面就是模型和 code mode 腳本看到的東西：名稱、參數、輸出。它要穩定：改名或改參數會讓對話裡已經載入的工具失效，也會讓模型學到的用法不再適用。所以介面有規範，而且被檢查。

**檢查**：`npm run check` 會跑兩支腳本。
- `test/tools-node.ts`：從 `src/agent/catalog.ts` 取得每一個工具（就是 runtime 裝的那一份），檢查下面能自動檢查的規則，並跟 `test/tools.snapshot.json` 比對。名稱、參數、結構化輸出有任何改變都會失敗；確定要改，就加 `--update` 更新快照，並在「紀錄」寫一行為什麼改。
- `test/tool-args-node.ts`：參數清理和時間格式的行為。

### 定義

- 一律用 `defineAppTool`（`src/agent/tools/common.ts`），不直接用 `defineTool`。它會先清理參數再驗證：選填參數是 `""`、`null`、`[]`，或 schema 不允許的 `0`，就當作沒給。模型常把沒用到的選填欄位填成這些值；以前每個工具各自處理，現在統一。小於下限的真實數值（半徑 50 公尺，下限 100）不會被吞掉，而是回報參數錯誤。
- 新的內建擴充一定要加進 `catalog.ts`，不能直接在 runtime 裡安裝，否則檢查看不到它。
- **擴充名稱不能改**：每個 Bot 的工具開關是用擴充名稱存的（`toolsets.ts`），改名會讓使用者的設定失效。
- schema 一律用 `typebox` 的 `Type`，不用 pi-ai 轉出口的同一個 `Type`（檢查會擋）。
- 結構化輸出的資料型別用 `type`，不用 `interface`（`interface` 不能指定成 `JsonValue`）。

### 名稱

- 工具和參數都用 snake_case。
- 會改動東西的動作是「動詞_名詞」：`set_alarm`、`add_calendar_event`、`reply_notification`。
- 讀取是 `read_`、`find_`、`list_`、`get_` 開頭，或者直接是資料來源的名字（`weather`、`contacts`、`health`、`screen_time`、`call_log`）。
- 同一個東西的「查看」和「控制」放在同一個工具，用 `action` 或 `mode` 區分，第一個值是 `status`：`media`、`do_not_disturb`。
- 已經上線的工具名稱不再改。

### 參數

- 每個參數都有說明；值本身就說明一切的列舉（`GET`／`POST`）可以例外。
- **時間一律是手機的當地時間**：日期時間 `YYYY-MM-DD HH:MM`（中間寫 `T` 也可以），日期 `YYYY-MM-DD`，時刻 `HH:MM`。範圍的結束如果只給日期，代表那天整天。解析一律用 `common.ts` 的 `parseLocalTime`、`parseLocalBound`、`parseClock`、`parseNextTime`、`parseDay`。
- 有單位的數字，名稱就帶單位：`radius_m`、`radius_km`、`minutes`、`hours`、`days`、`at_most_every_hours`。
- 選填參數的預設值寫在說明裡（「default 24」），程式裡用 `??` 而不是 `||`，因為空值已經被清掉了。
- 數量、天數這類參數要寫 `minimum`，`0` 才會被當作沒給。
- **互斥的選項用一個必填的列舉**：「時間或事件」這種二選一，不要做成選填參數，模型會兩個都填。`create_schedule` 的 `on` 是必填，`time` 也是其中一個值。
- **篩選條件不要用選填的數字**：模型會把沒用到的數字填成下限（`1`），結果真的篩掉東西。要開關的篩選用布林值（`upcoming_birthdays`、`missed_only`），沒用到時模型會填 `false`，跟不篩一樣。

### 輸出

- codemode 段落列出只給腳本的工具和參數名稱，是從 schema 自動產生的（`codemode.ts` 的 `signatureOf`），所以改了 schema 就會跟著改，不用手動同步；結果的欄位由 `describeTool` 給。
- 給模型的是文字。時間用跟輸入一樣的當地格式（`YYYY-MM-DD HH:MM`），模型讀到的可以直接再傳回來。
- **回傳一串紀錄的工具要有 `structuredOutputSchema`**：通知、聯絡人、相片、通話、簡訊、螢幕時間、健康、行事曆、地點、天氣、資料庫、雲端 API。這樣 code mode 腳本可以直接過濾、加總，不用解析文字。結構化輸出的欄位名稱也用 snake_case，時間也用當地格式。
- 一次回傳的量有上限時，要說還有多少、怎麼繼續讀（`offset=`、縮小 `query`）。

### 錯誤

- 不在 Android 上：`requireNative()`，訊息統一。
- 缺權限或設定：錯誤訊息要告訴使用者去哪裡開，路徑寫完整（「設定 › 手機 › 系統權限 › 螢幕使用時間」）。
- 其他錯誤：說清楚哪裡錯、模型下一步能做什麼（「list_schedules shows them」）。

### 改動

- 工具直接做，不跳核准（2026-10-23 拿掉了核准機制）。
- 只是打開一個畫面、讓使用者自己完成的（草稿、分享、地圖），輸出要說「使用者按了才會送出」。

## 工具清單

每一個工具都要列在這裡（`test/tools-node.ts` 會檢查）。「改動」：**唯讀**；**開畫面**＝打開畫面讓使用者完成；**直接**＝直接改。「結構化」＝有給腳本用的結構化輸出。模型怎麼拿到每個工具，見上面〈怎麼管理〉。

| 工具 | 工具組 | 做什麼 | 改動 | 結構化 |
|---|---|---|---|---|
| `device_info` | 手機狀態 | 電量、網路、勿擾、耳機、儲存空間 | 唯讀 | |
| `get_location` | 手機狀態 | 目前位置和地址 | 唯讀 | |
| `read_sensors` | 手機狀態 | 氣壓、方位、光線、距離感測 | 唯讀 | |
| `get_travel_time` | 手機狀態 | 開車、走路、騎車的距離和時間 | 唯讀 | |
| `weather` | 天氣 | 逐小時和逐日預報 | 唯讀 | ✓ |
| `find_places` | 地點 | 附近的店家，或用名字找分店 | 唯讀 | ✓ |
| `sql` | 資料庫 | 手機上的 SQLite | 直接 | ✓ |
| `set_alarm` | 手機 App | 設鬧鐘 | 直接 | |
| `set_timer` | 手機 App | 設計時器 | 直接 | |
| `compose_email` | 手機 App | 信件草稿 | 開畫面 | |
| `compose_sms` | 手機 App | 簡訊草稿 | 開畫面 | |
| `open_maps` | 手機 App | 地圖導航 | 開畫面 | |
| `open_link` | 手機 App | 網址或 app 連結 | 開畫面 | |
| `share` | 手機 App | 分享選單：文字，或 Bot 資料夾裡的一個檔案 | 開畫面 | |
| `speak` | 語音 | 唸出來 | 直接 | |
| `read_notifications` | 通知 | 收到的通知，留 30 天 | 唯讀 | ✓ |
| `reply_notification` | 通知 | 從通知回覆聊天 | 直接 | |
| `dismiss_notifications` | 通知 | 清掉通知欄的通知 | 直接 | |
| `media` | 手機控制 | 在放什麼、播放、暫停、上下一首 | 直接 | |
| `do_not_disturb` | 手機控制 | 勿擾模式，可到某個時間自動關 | 直接 | |
| `contacts` | 聯絡人 | 用名字找電話、email、生日 | 唯讀 | ✓ |
| `find_photos` | 相片 | 依時間、地點、相簿找照片 | 唯讀 | ✓ |
| `view_photos` | 相片 | 看照片（縮小） | 唯讀 | |
| `call_log` | 通話與簡訊 | 通話紀錄、未接來電 | 唯讀 | ✓ |
| `read_sms` | 通話與簡訊 | 簡訊 | 唯讀 | ✓ |
| `screen_time` | 螢幕使用時間 | 每個 app 用了多久、解鎖次數 | 唯讀 | ✓ |
| `health` | 健康 | 步數、心率、睡眠、運動、體重 | 唯讀 | ✓ |
| `read_calendar_events` | 日曆 | 讀行程 | 唯讀 | ✓ |
| `list_calendars` | 日曆 | 可以加活動的日曆 | 唯讀 | |
| `add_calendar_event` | 日曆 | 加活動 | 直接 | |
| `codemode` | 程式模式 | 用腳本一次呼叫多個工具 | 依呼叫的工具 | |
| `web_search` | 網路 | 搜尋 | 唯讀 | |
| `web_fetch` | 網路 | 讀網頁；內容要跑 JS 才出現時，在看不見的 WebView 裡渲染（`render`，或文字少於 300 字時自動）；`save_to` 把檔案下載進 Bot 的資料夾 | 唯讀；`save_to` 直接寫進自己的資料夾 | |
| `github_api` | GitHub | GitHub REST API | `GET` 唯讀，其他直接 | ✓ |
| `github_read_file` | GitHub | 讀 repo 裡的檔案 | 唯讀 | |
| `gcp_api` | Google Cloud | Google Cloud REST API | 讀取唯讀，寫入直接 | ✓ |
| `cloudflare_api` | Cloudflare | Cloudflare REST API | 讀取唯讀，寫入直接 | ✓ |
| `azure_api` | Azure | Azure REST API | 讀取唯讀，寫入直接 | ✓ |
| `read_screen` | 電腦畫面（只在有電腦的 Bot） | 電腦螢幕的截圖，加上前景 app、視窗標題、游標位置 | 唯讀 | |
| `use_screen` | 電腦畫面（只在有電腦的 Bot） | 一次多個滑鼠、鍵盤步驟，做完回傳截圖 | 直接 | |
| `read`、`write`、`edit`、`bash` | Sandbox 或檔案 | Bot 的資料夾：有 sandbox 時在遠端電腦，沒有時在手機上（`files/`：原生資料夾加 just-bash）；pi-durable 的 coding tools | 直接，只在 Bot 自己的資料夾裡 | `bash` |
| `read_attachment` | 固定開啟 | 讀附件的其他段落、頁數、搜尋，或把 PDF 頁面轉成圖 | 唯讀 | |
| `scan_document` | 固定開啟 | 打開掃描畫面，掃完變成附件 | 開畫面 | |
| `read_skill` | 固定開啟 | 讀一份 skill | 唯讀 | |
| `create_schedule` | 固定開啟 | 新增排程（時間或事件） | 直接 | |
| `schedule_followup` | 固定開啟 | 稍後自己回來看 | 直接 | |
| `list_schedules` | 固定開啟 | 這個 Bot 的排程 | 唯讀 | |
| `delete_schedule` | 固定開啟 | 刪排程 | 直接 | |
| `notify` | 固定開啟 | 發通知 | 直接 | |
| `update_memory` | 固定開啟 | 改 MEMORY.md | 直接（每次都是一個看得到的步驟） | |
| `tool_search` | 固定開啟 | 載入需要時才載入的工具 | 唯讀 | |

## 新工具上線前

0. **照介面規範寫**，用 `defineAppTool`，加進 `catalog.ts` 和上面的工具清單，再跑 `npm run check`；第一次會說是新工具，確認後用 `--update` 加進快照。
1. **量測前後**：在 S24 上跑 `test/tool-cost.sh <DevTools port> [mcp-<server> ...]`，加入新工具前後各跑一次，記下這組工具的字元數，以及短請求的提示大小變化。
2. **決定載入方式**：照上面的原則，在 `toolsets.ts` 設好 `load`。
3. **用一般人的說法實測**：在 S24 上用暫時的 Bot 問 2–3 題，不提工具名稱，也不說「用 codemode」。記下有沒有用對工具、呼叫了幾次、花了幾秒、答案對不對。
   - 需要時載入的工具，要確認模型會自己用 `tool_search` 載入，或改用其他能完成工作的工具，而不是憑記憶回答。
   - 會寫入的工具，用測試資料確認寫對了，測完復原。
4. **更新這份文件**：更新下面的表格，並在「紀錄」加一行。

## 目前的量測

2026-10-22 的量測，當時工具全部直接提供；2026-10-23 改成程式模式為主之後，每次請求的大小見〈紀錄〉，這張表等重新量過再更新。

2026-10-22，S24，GPT 6.1 Sol。暫時的 Bot 開著全部內建工具（MCP 服務那兩列是 2026-10-21 另外量的）。tokens 是用字元數 ÷ 4.9 估計的；這個比例是實測得到的：24,495 字元的定義讓請求多了 5,029 tokens。

| 工具組 | 擴充 | 載入 | 工具數 | 字元 | 約 tokens |
|---|---|---|---:|---:|---:|
| 排程（固定開啟） | `triggers` | 常駐 | 5 | 3,845 | 785 |
| 手機 App | `phone_apps` | 常駐 | 7 | 3,132 | 639 |
| 日曆 | `calendar` | 常駐 | 3 | 2,107 | 430 |
| 通知 | `notifications` | 常駐 | 3 | 2,032 | 415 |
| 手機狀態 | `device` | 常駐 | 4 | 1,770 | 361 |
| 程式模式 | `codemode` | 常駐 | 1 | 1,636 | 334 |
| 附件（固定開啟） | `attachments` | 常駐 | 2 | 1,476 | 301 |
| 相片 | `photos` | 常駐 | 2 | 1,272 | 260 |
| 手機控制 | `phone_control` | 常駐 | 2 | 1,238 | 253 |
| 地點 | `places` | 常駐 | 1 | 1,166 | 238 |
| 通話與簡訊 | `calls_sms` | 常駐 | 2 | 947 | 193 |
| 資料庫 | `database` | 常駐 | 1 | 901 | 184 |
| 天氣 | `weather` | 常駐 | 1 | 778 | 159 |
| 健康 | `health` | 常駐 | 1 | 734 | 150 |
| 記憶（固定開啟） | `memory` | 常駐 | 1 | 732 | 149 |
| 網路 | `web` | 常駐 | 2 | 1,120 | 229 |
| 工具搜尋（固定開啟） | `tool-search` | 常駐 | 1 | 615 | 126 |
| 語音 | `speech` | 常駐 | 1 | 595 | 121 |
| 聯絡人 | `contacts` | 常駐 | 1 | 562 | 115 |
| 螢幕使用時間 | `screen_time` | 常駐 | 1 | 434 | 89 |
| skills（固定開啟） | `skills` | 常駐 | 1 | 324 | 66 |
| Sandbox 或檔案 | `coding-tools` | 常駐 | 4 | 2,715 | 554 |
| GitHub | `github` | 需要時載入 | 2 | 1,421 | 290 |
| Google Cloud | `gcp` | 需要時載入 | 1 | 999 | 204 |
| Cloudflare | `cloudflare` | 需要時載入 | 1 | 974 | 199 |
| Azure | `azure` | 需要時載入 | 1 | 938 | 191 |
| Cloudflare（MCP） | `mcp-cloudflare` | 需要時載入 | 23 | 11,400 | 2,327 |
| superlogical（MCP） | `mcp-superlogical` | 需要時載入 | 10 | 3,615 | 738 |

- 常駐的定義合計 26,959 字元。
- 短請求的提示：內建工具全開時 8,103 tokens，全關時 2,488 tokens（2026-10-22，不含 MCP 服務；MCP 那兩列是 10-21 的量測）。

## MCP 服務市集

設定 › MCP › 瀏覽服務列出的服務（`src/agent/mcp-catalog.ts`），都在 2026-10-21 從 Mac 實際試過：要嘛不用登入就能連，要嘛 OAuth 接受動態註冊，而且接受 pi 的本機跳轉網址（`http://127.0.0.1:47823/oauth/mcp`）。

- **跳轉網址的選擇**：30 個知名服務中，只有 13 個接受 App 的自訂網址（`dev.geminixiang.pimobile:/oauth/mcp`），接受本機網址的有 22 個，而且前面那 13 個也都在裡面。所以登入一律用本機網址（`LoopbackPlugin.java`）。
- **不在市集裡的**：GitHub、HubSpot、Box 不支援動態註冊；Figma 拒絕註冊（回 403）。
- **加入市集前**：照「新工具上線前」的流程量測。不用登入的服務可以直接從 Mac 量工具定義（`tools/list`）；要登入的，連接後用 `test/tool-cost.sh` 量。在 S24 上實際登入並用一般說法問過的，標成「已實測」。

不用登入的服務，工具定義的大小（全部都是需要時載入）：

| 服務 | 工具數 | 標成唯讀 | 字元 | 約 tokens |
|---|---:|---:|---:|---:|
| Context7 | 2 | 2 | 4,938 | 1,008 |
| DeepWiki | 3 | 0 | 1,054 | 215 |
| Exa | 2 | 2 | 2,081 | 425 |
| Hugging Face | 4 | 4 | 7,899 | 1,612 |
| Cloudflare 文件 | 2 | 2 | 998 | 204 |

工具有沒有標成唯讀（`readOnlyHint`）只影響對話恢復時會不會重跑：唯讀的可以重跑，其他的不會。

## 紀錄

| 日期 | 變更 | 短請求的提示 | 備註 |
|---|---|---|---|
| 2026-10-21 | 內建工具全部常駐 | 6,920 tokens | 內建工具約佔 5,000 tokens（72%） |
| 2026-10-21 | MCP 服務需要時載入、預設不給 Bot | 9,223 → 7,510 tokens | 只開 Cloudflare MCP：直接帶工具 9,223、延遲載入 7,510；Workers 與 D1 的問題正確率與時間相同 |
| 2026-10-21 | Sandbox、GitHub、三家雲端改為需要時載入 | 6,920 → 5,914 tokens | 系統版本、GitHub repo、GCP 專案三題都答對，8–17 秒 |
| 2026-10-22 | 整理工具介面：`defineAppTool` 統一清理參數、時間格式和核准；紀錄類工具加結構化輸出；`catalog.ts` 一份清單；`npm run check` 檢查規範和快照 | 7,620 → 8,103 tokens（補齊參數說明 +287；code mode 列出全部 16 個結構化輸出的欄位 +196） | 介面改變：`find_places.radiusKm` → `radius_km`；`contacts.birthdays_within_days` → `upcoming_birthdays`（模型會把沒用到的天數填成 1，真的篩掉了人）；`create_schedule.on` 改成必填，多一個 `time` 值（模型會把選填的 `on` 隨便填一個事件，例如 `wifi`，跟 `time` 衝突而失敗兩次）；輸出時間一律 `YYYY-MM-DD HH:MM`；結構化輸出的欄位改成 snake_case（`weather` 的 `temperature_c`、`rain_chance`…，`find_places` 的 `distance_m`、`opening_hours`，`sql` 的 `last_insert_id`），code mode 的說明改成從 schema 產生，不再手寫。S24 上 11 題：行程、加活動（拒絕後回「好，沒有加入行事曆」）、附近 500 公尺、通話次數、聯絡人電話、勿擾開關、三天螢幕時間（code mode 用結構化輸出）、LINE 誰傳最多，都對；之後用 code mode 依新欄位名稱算降雨（`rain_chance`）、咖啡廳距離（`distance_m`）、LINE 每人則數，也都對。發現「提醒我」選了鬧鐘而不是 `schedule_followup`、鬧鐘沒辦法取消，留給之後 |
| 2026-10-23 | 程式模式的易用性，加入較弱的模型一起測：`find_places` 的 category 可以只給值（`cafe` 會找 `amenity:cafe` 和 `shop:cafe`）；`near`、`place`、`origin`、`destination` 接受 `get_location` 的整段文字；`tool_search` 的說明改成只載入那 4 個看圖工具，「需要時載入」段落縮成一句 | 每次請求不變（GPT 3.3k、Claude 2.4k tokens） | 介面改變：`find_places.category` 的說明。七題（附近咖啡店、明天台北下雨、這週步數、未接來電、天氣加行程、Mac 硬碟、最大的三個 app），GPT 6.1 Sol、Claude Opus 5.5、gpt-6-luna、claude-haiku-5-5 各一次。改之前（V1）：luna 和 haiku 把 category 寫成 `cafe`，回答附近沒有咖啡店或只找到 6 公里外的；luna 用 `tool_search` 找 bash 和腳本工具，白跑一輪。改之後（V3）：28 題全部答對；七題合計 Sol 71.7k tokens／106 秒、Opus 64.8k／67 秒、luna 69.0k → 50.5k／68 秒、haiku 83.9k → 64.0k／51 秒 |
| 2026-10-23 | **改成程式模式為主**：只直接提供 `codemode`、coding tools、`update_memory`、`tool_search`；看圖片的工具需要時載入；其他（含 MCP）只給腳本，codemode 段落列名稱和參數名稱。手機工具組的說明段落縮成一句或拿掉，直接模式的提示從 1.9k 縮到約 0.9k 字元。面板改成一個「工具」清單 | 每次請求（第一次呼叫的輸入）：GPT 8,799 → 3,373 tokens，Claude 12,596 → 2,433 | 介面改變：除了上面 7 個，所有工具 `callers` 變成 `["tools"]`，4 個看圖工具變成 deferred；拿掉「程式模式」工具組（固定開啟）。S24，Bot 在 Mac 上，GPT 6.1 Sol 和 Claude Opus 5.5 各一次，全部答對。每題的輸入 tokens：手機題（天氣、明天行程、走幾步、天氣加行程）GPT 17.6k–27.5k → 6.8k–9.0k、Claude 29.4k → 5.6k–8.0k；附近咖啡店 GPT 38.0k → 16.9k、Claude 46.8k → 28.2k，但變慢（GPT 30 → 47 秒、Claude 14 → 51 秒，拆成 3–4 個腳本）；Mac 題（硬碟、音量、視窗、Wi‑Fi、對話框）GPT 18k–28k → 6.8k–12.3k、Claude 30k–47k → 8.0k–13.8k。Claude 有兩次把工具呼叫寫成文字（改前改後各一次） |
| 2026-10-23 | 直接模式的提示：拿掉 `screencapture` 加 `read` 的看畫面方式，畫面一律用 `read_screen`／`use_screen`，也拿掉「每一步截圖確認」（`use_screen` 本來就回傳截圖） | 提示少約 20 tokens | S24 → Mac mini，七個平常的問題，不指定方法，GPT 6.1 Sol 和 Claude Opus 5.5 各一次：全部答對；硬碟、音量、視窗、Wi‑Fi、外觀、計算機都用 shell（df、osascript、networksetup），只有「畫面上有沒有對話框」看畫面。改之前看畫面是 `screencapture` 存全尺寸 PNG 再 `read`；改之後用 `read_screen`：對話框那題 GPT 22→17 秒、41k→28k tokens，Claude 17→11 秒、66k→31k；計算機那題 Claude 不再截圖確認，27→18 秒、102k→82k。各只跑一次，數字有誤差 |
| 2026-10-23 | 「電腦畫面」成為內建工具組（`read_screen`、`use_screen`），有電腦的 Bot 就有，手機上不可用 | 2 個新工具，需要時載入 | S24 → Mac mini，三題各兩次全部答對：Claude 12–24 秒、3–4 次呼叫；GPT 32–61 秒、5–7 次（供應商回應慢，有過載）。都會自己用 `tool_search` 載入 |
| 2026-10-23 | 電腦上的畫面操控改成自己寫的 `pi-mobile mcp computer`（Go，macOS），取代 computer-use-mcp | 2 個工具，1,569 字元（computer-use-mcp 4,108），需要時載入 | 同樣三題、兩個模型各兩次，全部答對、0 次核准、不用 Node：GPT 每題 26–31 秒、4–5 次呼叫（原本 39–170 秒、6–24 次）；Claude 14–24 秒、3–4 次（原本 28–55 秒、4–7 次）；輸入 tokens 少 40–60%。細節見 [research/computer-use-mcp-eval.md](research/computer-use-mcp-eval.md) |
| 2026-10-23 | 拿掉所有核准：工具、MCP、容器的 egress 都直接執行；`github_api`、`gcp_api`、`cloudflare_api`、`azure_api`、`sql` 拿掉只給核准框用的 `reason` 參數 | 介面改變：上面 5 個工具少一個參數 | S24：容器裡 clone、push 分支再刪掉，24 秒，沒有跳任何對話框；新增、列出、刪除排程加上電腦操控截圖，31 秒，同樣沒有對話框 |
| 2026-10-23 | 評估 computer-use-mcp（電腦上的畫面操控，`computer://` 執行），不內建 | 1 個工具，4,108 字元（約 1,000 tokens），需要時載入 | 三個只能靠畫面完成的工作，GPT 6.1 Sol 和 Claude Opus 5.5 各兩次，全部答對；每題 28–170 秒、4–24 次模型呼叫、4–22 次核准（連截圖都要），截圖每張 2–7 秒，輸入 66k–373k tokens。核准次數、截圖速度、要有 Node 三點過不了日常使用；改成自己寫，達標才內建。細節和標準見 [research/computer-use-mcp-eval.md](research/computer-use-mcp-eval.md) |
| 2026-10-22 | 系統提示加一句：同一輪要求的工具會同時執行，已知要查的都一起要求 | 多約 40 tokens | 先確認工具本來就能平行：沒有工具設成依序執行；12 個查詢類原生呼叫（行事曆、聯絡人、相片、通知、通話、簡訊、螢幕時間、健康、狀態、定位、HTTP、SQL）同時發出，總時間就是最慢那個（S24 1.3–1.4 秒）。改的是模型的習慣。模擬器、GPT 6.1 Sol、全新 Bot，每題前後各兩次，每輪要求幾個工具：「週末去台中：天氣、餐廳、行程」前後都是一輪 4 個（本來就會）；「比較 iPhone 17 和 Pixel 11」1-1-1、1-1-3 → 1-2-3、1-5、1-4（第一個搜尋仍單獨，之後一起），123／168 秒 → 136／107／128 秒；房貸範例 3-4-2-1-1-1、3-4-1-1 → 3-4-1-1 兩次，209／158 → 139／138 秒。S24（同模型）：台中 4-3、3-1（97／70 秒）→ 3-1、4（68／68 秒）；比較手機 1-1-4、1-3-3（154／142 秒）→ 1-3-1、1-1（93／87 秒）；房貸 3-4-2-1-1 兩次（170／126 秒）→ 3-4-1-1-1、3-4-1-1-1-1-1（141／152 秒，後者多抓了幾頁）。`web_search` 的說明縮短，不再重複這條規則 |
| 2026-10-22 | `web_search` 的說明：一次 20–60 秒，獨立的搜尋在同一輪一起要求 | 定義多約 30 tokens | 搜尋本來就平行執行（pi-durable 預設 `toolExecution: "parallel"`），但模型幾乎都一次只搜一個。改後兩次範例都把三家銀行分開、同時搜尋：一次 3 個搜尋共 40 秒（之前一次一個，3 個共 126 秒）；另一次多搜了一輪，共 6 個、95 秒。總時間 192／118 秒（之前 194／119），兩次都查齊三家的一般利率和青安利率。也試過把搜尋換成較快的模型：`gpt-6-luna` 單次 23 秒（`gpt-6.1-sol` 48–55 秒），但查到的銀行比較少；`gpt-6-astra`、`gpt-5.6-luna`、`gpt-5.6-terra` 都不比較快；`reasoning.effort: low` 沒有變快。都沒有採用 |
| 2026-10-22 | 依實際使用的過程改了四處：`web_fetch` 讀 PDF 的文字（跟附件同一套）；`render` 的說明改成很少需要；Bot 的資料夾工具（Sandbox 或檔案）改為常駐；試過 code mode 的「只回傳需要的部分」 | 常駐：短請求多 452 tokens（Sandbox 開著時 454 → 906） | 量法：S24、全新 Bot、首頁範例「查台銀、土銀、合庫…整理成表格檔」，每項改動前後各跑兩次，記錄每次模型呼叫的時間和 tokens、每個工具的時間。基準 291／222 秒。① PDF：臺銀的利率表原本是 1.3 萬 tokens 的亂碼，模型再到 sandbox 下載用 pdftotext；改後直接拿到 981 tokens 的文字，222／149 秒。② `render`：模型主動要求從 1–2 次變 0 次，土銀的頁面照樣自動渲染。③ 常駐：原本 6 次中有 5 次在載入 bash 後整段重讀 1.0–1.6 萬 tokens（多 4–8 秒）；改後沒有 `tool_search`，模型時間 59／66 秒（之前 69／98）。④ code mode 加一句「只回傳需要的部分」：「這四個網頁各一句話重點」前後都回傳 18,913 字的全文，沒有效果，沒有採用。不論怎麼改，`web_search` 都佔大半時間（46–179 秒）|
| 2026-10-22 | `web_fetch` 加 `render` 和 `save_to` | 網路的定義 663 → 1,120 字元（約 +93 tokens，估計） | `render`：自己寫的 `PagePlugin.java`，一個不掛在畫面上的 WebView，載入後等文字 2 秒不再變化（最多 30 秒）才取 HTML；只走 http/https、沒有橋接、不能開檔案或彈出視窗，用完就銷毀。評估過 `@capgo/capacitor-inappbrowser`（隱藏模式也能做到，但 APK +1.3 MB，是給使用者看的完整瀏覽器）；自己寫的 APK 幾乎不變，渲染時記憶體約 +12 MB，結束後回到原本。文字少於 300 字時自動渲染；另外修正擷取文字時只取 `<main>`，但內容不在裡面的頁面（中信）。`save_to`：手機資料夾由原生串流寫入，sandbox 經原生 HTTP 再寫過去。模擬器上：「中信官網美元匯率多少（附網址）」渲染後答出 32.4450／32.6050，原本的抓取只拿到空殼；「把這份 PDF 存下來」「把這張圖存下來」在手機資料夾和 sandbox 都存好；檔案檢視器多了「用其他 app 開啟」，PDF 開在雲端硬碟的檢視器、PNG 開在相簿 |
| 2026-10-22 | 檔案：沒有 sandbox 時，`read`、`write`、`edit`、`bash` 改在 Bot 自己在手機上的資料夾（`files/`）；`share.sandbox_path` → `path` | 模擬器（Opus 5.5）：開「檔案」比關掉多 298 tokens（說明 110，其餘是工具搜尋的清單）；說明原本寫了三句，多 461 | 檔案存在 app 的原生資料夾（`BotFilesPlugin.java`），bash 是 just-bash 跑在 Worker，檔案操作經主執行緒轉給原生：碰不到資料夾外的東西（包括 app 自己的 SSH 金鑰），也不能連網。瀏覽器版不能用的指令（`tar`、`yq`、`xan`、`sqlite3`、`python`、`gzip`、`html-to-markdown`）不註冊。模擬器上 4 題：「這個月的開銷存成表格檔」載入工具寫成 CSV 並記在記憶；「再加三筆，咖啡多少、哪類最多」用 `edit` 追加；「直接從檔案重算一次」用 `bash` 的 `awk` 算，抓到前一題心算的總數錯誤（1,155 → 1,215）；「把開銷表傳給我」開出分享選單。刪除 Bot 時資料夾一起刪掉；有 sandbox 時照舊走遠端。`share` 的參數改名，因為沒有 sandbox 時檔案在手機上；舊對話裡的 `sandbox_path` 照樣顯示 |
| 2026-10-22 | 健康（Health Connect，系統 API） | 7,505 → 7,620 tokens | 權限都允許後五種資料都是空的：Samsung Health 的「同意處理健康和保健資料」沒開，它就不寫入 Health Connect。「這禮拜睡得怎樣」11 秒，正確說沒有資料並指出設定。打開同意、回到 Samsung Health 主畫面後開始同步（只同步之後的資料）：「今天走了幾步、這週呢」9 秒，答出今天 25 步，並說明其他天沒有資料不代表沒走路 |
| 2026-10-22 | 掃描文件（`scan_document`）、掃描頁在手機上 OCR | 7,401 → 7,505 tokens | 掃描版收據 PDF：OCR 0.17 秒，「總共多少、買了什麼」8 秒對，只送 52 tokens 的文字而不是一張圖；「幫我掃描桌上這張紙」叫出系統掃描畫面，取消後回「這次沒有掃描」 |
| 2026-10-22 | 排程的新事件：開始充電、連上 Wi‑Fi、到達／離開地點 | 7,246 → 7,401 tokens | 「每天晚上回到家提醒我倒垃圾」12 秒，用記憶裡的住址建 18:00–23:59 到達時、一天一次（拒絕核准）。觸發：模擬插電立刻執行、同一次充電不重複；Wi‑Fi 和地點在重新設定時不再誤觸發（系統回報的「目前狀態」不算事件） |
| 2026-10-22 | 通話與簡訊、螢幕使用時間；pi 當數位助理 | 6,942 → 7,246 tokens | 「這兩天有沒有未接來電」10 秒對；「這幾天有收到驗證碼嗎」第一次只搜「驗證碼」三個字，說明改成不用 query 讀最近的簡訊後對；「這禮拜誰傳簡訊給我」13 秒對；「今天滑手機多久」「這禮拜每天平均多久」11 秒對：pi 自己 26 小時，跟系統的 `dumpsys usagestats` 一致（測試時螢幕一直亮在 pi）。另外改成螢幕關掉就停止計時、不到 1 分鐘不算。長按側邊鍵叫出 pi：截圖和畫面文字進輸入框，「這個畫面在講什麼、手機型號」9 秒對 |
| 2026-10-22 | 圖片裡的 QR／條碼在手機上解碼（不是工具） | 不變 | 傳一張有 Wi‑Fi QR 的海報照片問「Wi‑Fi 名稱跟密碼」，6 秒答對，答案來自解碼結果 |
| 2026-10-22 | 聯絡人、相片 | 6,517 → 6,942 tokens | 「X 的電話幾號」答對（模型把不用的生日天數填 0，改成 0 不篩後才對）；「最近有誰生日」對（通訊錄沒有生日）；「昨天拍了哪些、最後一張是什麼」19 秒，3 張都描述正確；「七月底在板橋拍了什麼」用地名找到 7 張，19 秒。EXIF 地點讀一次就存起來：200 張 3.5 秒 → 第一次 0.4 秒、之後 36 ms |
| 2026-10-22 | 回覆／清除通知、音樂、勿擾（都靠通知存取） | 6,126 → 6,517 tokens | 「開勿擾到 HH:MM」兩次都對，到時間自己關（精準鬧鐘）；「把那則測試通知清掉」第一次找錯工具，改成用一個 query 比對 app、標題、內容後答對；「在放什麼歌」對。回覆和播放控制待真實的聊天通知和播放器 |
| 2026-10-22 | 附件：`read_attachment`，固定開啟 | 5,919 → 6,126 tokens | 租約 PDF、掃描頁、docx、xlsx、5,000 列 CSV、27 頁手冊各一題，全部答對，6–22 秒。試算表用 `sql` 算；大 PDF 用 `read_attachment` 讀頁；問版面時自己用 `images=true` 看頁面 |
| 2026-10-21 | MCP 服務市集（26 個服務）、登入改用本機網址 | 不變（服務預設不給 Bot） | Cloudflare 監控經由市集連接、用本機網址登入（8 個工具）；查詢記錄要核准，拒絕後沒有執行 |
