# 工具與 context

Bot 的每次請求都帶著它能用的工具說明（名稱、描述、參數 schema）。工具越多，每次請求越大，模型也越容易選錯。這份文件記錄工具怎麼交給模型、各佔多少，以及新工具上線前要做的量測。

## 怎麼管理

**開關**由使用者在 Bot 面板決定（`src/agent/toolsets.ts`）：
- 內建工具預設開啟。
- 連接的服務（MCP）預設關閉，要在設定 › MCP 或 Bot 面板裡給特定的 Bot。
- 程式模式、記憶、附件、skills、排程一律開啟，不列在面板上。

**模型怎麼拿到工具**由每個工具在 `defineAppTool` 宣告（`reach`），使用者不用管。從 2026-10-23 起以程式模式為主：

| 方式 | 哪些工具 | 每次請求帶什麼 |
|---|---|---|
| **直接提供**（`reach: "model"`） | 〈工具總圖〉標 † 的 | 完整定義 |
| **需要時載入**（`reach: "loaded"`） | 結果是要模型看的圖片，〈工具總圖〉標 ＊ 的（沒有結構化輸出的工具，腳本拿不到圖片；有的話，腳本用 `image(r.screenshot)` 顯示，例如 `use_browser`） | 只有名稱（`on-demand.ts`），用 `tool_search` 載入，之後留在那段對話；名稱列在系統提示「Load these with tool_search」那段，只列這個 Bot 在所在地（手機或電腦）用得到的 |
| **只給腳本**（預設） | 其他全部，包括 MCP 服務（`callers: ["tools"]`） | codemode 段落裡一行一組：工具名稱和參數名稱（`codemode.ts`）；細節由腳本用 `describeTool(name)` 查 |

- 只給腳本的工具，它們的說明段落也只留模型一定要知道的一句（例：通知不可信、草稿要使用者自己送出）；能從工具名稱看出來的不寫。
- 代價：
  - 模型不認得參數時，要先用一個腳本查 `describeTool`，多一次來回。
  - 需要好幾步的手機任務（例：找附近咖啡店再算步行時間）會拆成幾個腳本，可能比以前慢。

## 介面規範

工具的介面就是模型和 code mode 腳本看到的東西：名稱、參數、輸出。它要穩定：改名或改參數會讓對話裡已經載入的工具失效，也會讓模型學到的用法不再適用。所以介面有規範，而且被檢查。

**檢查**：`npm run check` 會跑兩支腳本。
- `test/tools-node.ts`：從 `src/runtime/catalog.ts` 取得每一個工具（就是 runtime 裝的那一份），檢查下面能自動檢查的規則，並跟 `test/tools.snapshot.json` 比對。名稱、參數、結構化輸出有任何改變都會失敗；確定要改，就加 `--update` 更新快照，並在「紀錄」寫一行為什麼改。
- `test/tool-args-node.ts`：參數清理和時間格式的行為。

### 定義

- 一律用 `defineAppTool`（`src/agent/tools/common.ts`），不直接用 `defineTool`。它會先清理參數再驗證：選填參數是 `""`、`null`、`[]`，或 schema 不允許的 `0`，就當作沒給。模型常把沒用到的選填欄位填成這些值；以前每個工具各自處理，現在統一。小於下限的真實數值（半徑 50 公尺，下限 100）不會被吞掉，而是回報參數錯誤。
- `defineAppTool` 除了工具本身，還要宣告三件事，檢查和快照都看它們，catalog 也照它們裝工具，不再有依名稱的名單：
  - `effect`（必填）：`read` 唯讀、`screen` 打開畫面讓使用者完成、`direct` 直接改。有好幾種動作的工具寫最強的一種。工具清單的「改動」欄要寫出同一個字（唯讀、開畫面、直接），檢查會比對。
  - `reach`：`script`（預設，只給腳本）、`loaded`（需要時載入）、`model`（直接提供）。
  - `needs`：少了它這個工具就沒有意義的原生方法，寫 contract 上的方法本身（`[Records.calls]`），不是字串。透過 `currentPlace` 這類 helper 才呼叫、但工具的主要用途就靠它的，也要寫（`weather` 寫 `Phone.getLocation`）。這支手機沒實作其中任何一個方法時，這個工具不安裝；一個擴充的工具全部裝不了時，整個擴充也不裝，面板也不列它的工具組。只在某些參數下才用到的方法不寫：沒實作時呼叫它會丟出「`X.y` is not available on this device」。「有就用、沒有也行」的呼叫，在呼叫前用 `native.implements(Page.render)` 判斷。
- 新的內建擴充一定要加進 `catalog.ts`，不能直接在 runtime 裡安裝，否則檢查看不到它。

### 提示段落

- 系統提示的每一段都用 `appSection(key, budget, render)`（`src/section.ts`）定義，不直接用 `section`（code-rules 擋）。超過上限的段落會整行截斷，結尾寫明被截掉，並記一筆 `prompt.section_over_budget`。
- 由資料組成的段落（其他 Bot、記憶、資料表、MCP 服務自己的說明）一定要想清楚資料多的時候長什麼樣子：只放模型這一題需要的，例如其他 Bot 只列名字、不列工作說明。
- `test/prompt.ts` 檢查兩件事。一是預設 Bot 的完整提示和 `test/prompt.snapshot.json` 一致，改了提示就加 `--update`，並在「紀錄」寫一行。二是塞滿資料時，例如刪掉 40 個 Bot、多 20 個 Bot、兩份記憶寫滿、工具組全開，每段都不超過上限、也不會被截斷，總長在 `PROMPT_BUDGET` 內，刪掉的 Bot 不出現。
- **每個工具宣告自己屬於哪些工具組**（`defineAppTool` 的 `groups`，固定開著的寫 `"always"`；pi-durable 的 `CodingTools` 在 `catalog.ts` 用 `adopt` 補上）。每個 Bot 只存關掉的工具組 id（`Bot.off`），開 runtime、切開關、換地點時，由 `BotToolsets` 依「關掉的組 × 地點」算出這個 Bot 不能用的工具，寫進 `pi.agent.tools.remove`。所以擴充可以自由改名、拆開、合併、搬工具，Bot 的設定都不受影響；工具換組才是產品變更。工具組 id 不改。
- schema 一律用 `typebox` 的 `Type`，不用 pi-ai 轉出口的同一個 `Type`（檢查會擋）。
- 從常數清單做的列舉用 `oneOf(LIST, options)`（`common.ts`），不用 `Type.Union(LIST.map(Type.Literal))`：後者的 TS 型別是 `never`。
- 結構化輸出的資料型別用 `type`，不用 `interface`（`interface` 不能指定成 `JsonValue`）。

### 名稱

- 工具、參數、擴充、工具組 id 都用 snake_case。
- **三層名字**：工具組（`toolsets.ts`，面板上的一個開關，id 存在每個 Bot 裡，不改）→ 擴充（實作和載入的單位，不存，可以改）→ 工具（模型看到的名字；改了，舊對話裡模型可能照舊名叫一次）。擴充名稱是它處理的東西（`calendar`、`computer_shell`），不是實作（不叫 `sandbox`、`triggers`）。
- **以使用者的身分操作畫面**的工具，名稱寫出在哪一台、以使用者身分：`phone_read_as_user`、`phone_act_as_user`、`computer_read_as_user`、`computer_act_as_user`，擴充是 `phone_as_user`、`computer_as_user`。它們對 App 來說就是使用者本人，App 可能擋，說明的第一句要寫是最後手段。Bot 自己的瀏覽器（`read_page`、`use_browser`）不算。在畫面上點、打字只出現在這幾個工具：其他工具開了畫面（草稿、地圖、`connections` 的 Wi‑Fi 面板）就停在那裡，由使用者或 `phone_act_as_user` 接著做。`test/tools-node.ts` 檢查名字帶 `as_user` 的工具是需要時載入、而且只放在 `*_as_user` 擴充裡；唯一的例外是一組的入口工具（`phone_open_as_user`）：直接提供，`defineAppTool` 的 `loads` 要列出同組的其他工具，它的結果用 `control.addTools`（和 `tool_search` 同一個機制）把它們載入。`phone_note_as_user` 屬於這組，但放在 `skills.ts` 的 `app_notes` 擴充，因為它寫的是技能資料（`BotSkillsDoc`）。
- 會改動東西的動作是「動詞_名詞」：`set_alarm`、`add_calendar_event`、`reply_notification`。
- 讀取是 `read_`、`find_`、`list_`、`get_` 開頭，或者直接是資料來源的名字（`weather`、`contacts`、`health`、`screen_time`、`call_log`）。
- 同一個東西的「查看」和「控制」放在同一個工具，用 `action` 或 `mode` 區分，第一個值是 `status`：`media`、`do_not_disturb`。
- 已經上線的工具名稱不再隨意改。工具名稱不存，改名等於刪掉舊工具、加上新工具，對話裡已載入的舊名字會失效；真的要改，在「紀錄」寫理由。

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

- 要原生 plugin 的工具：在工具寫 `needs`（上面〈定義〉），沒實作那些方法的平台不會安裝，不用在工具裡檢查（[capabilities.md](design/capabilities.md)）。工具組要不要出現在面板，由它的工具推導；工具組的 `needs`（`toolsets.ts`）只留給沒有工具能承載的條件：`files` 要 `BotFiles`（那個擴充沒有工具），`tw_stocks` 要 app 內的原生 HTTP。
- 缺權限或設定：錯誤訊息要告訴使用者去哪裡開，路徑寫完整（「設定 › 手機 › 系統權限 › 螢幕使用時間」）。
- 其他錯誤：說清楚哪裡錯、模型下一步能做什麼（「list_schedules shows them」）。

### 改動

- 工具直接做，不跳核准（2026-10-23 拿掉了核准機制）。
- 只是打開一個畫面、讓使用者自己完成的（草稿、分享、地圖），輸出要說「使用者按了才會送出」。
- **從背景開畫面**：pi 在前景時一律可以開。pi 在背景時（例如 Bot 剛用 `phone_act_as_user` 切到別的 App），只有開著「代你操作 App」的 Bot 可以開。會開畫面的原生方法在合約上標 `opens: "screen"`，用到它的工具要宣告 `effect: "screen"`（`test/tools-node.ts` 檢查），catalog 在這種工具執行前呼叫 `openScreen`（`apps.ts`），工具自己不呼叫（`test/code-rules.ts` 檢查）；`connections` 只有某些動作會開面板，改把 `mayOpen` 交給原生：Android 讓無障礙服務綁著的 App 從背景開別的 App，但那是整個 pi 共用的系統開關，關掉 Bot 自己的開關就不該被打擾。iOS 沒有這個例外，只看前景。原生在真的 `startActivity` 那一行再檢查一次（`AppsPlugin.launch`、`PhoneStatePlugin.setConnection`），因為系統從背景擋下時不會丟例外，工具會以為成功；鬧鐘、計時器不開畫面，所以只有這層原生檢查，iOS 的 AlarmKit 在背景照樣能設。

### 原生 plugin

工具和 app 呼叫的原生功能（Android 的 Kotlin plugin、iOS 的 Swift plugin）都在 `src/plugins/` 有一份 contract：每個方法的參數和回傳 schema，以及事件的 schema。它是兩個平台要照著實作的介面。

- 一律用 `definePlugin`（`src/plugins/define.ts`）宣告，不直接用 `registerPlugin`（檢查會擋）。
- 回傳的資料在呼叫時用 contract 驗證一次，不符就丟出「`X.y`格式不符」的錯誤；事件不符就記一筆 `plugin.event_mismatch` 並略過。這支手機沒實作的方法，呼叫時丟「`X.y` is not available on this device」。
- 哪些方法有實作，看 Capacitor 的 `PluginHeaders`，細到方法（`native.implements(method)`）；整個 plugin 有沒有，用 `native.has(name)`。
- `test/plugins-node.ts`（在 `npm run check` 裡）掃 Java 的 `@PluginMethod` 和 Swift 的 `pluginMethods`：contract 的每個方法 Android 都要有；兩個平台都不能有 contract 沒寫的方法；contract 和 iOS 已實作的方法記在 `test/plugins.snapshot.json`。改了 contract，或 iOS 多實作一個方法，都要 `--update`，並在「紀錄」寫一行。
- 在 iOS 實作一個方法：照 contract 的 schema 回傳，跑 `npm run check` 更新快照；`needs` 只用到已實作方法的工具，就會在 iOS 出現。
- 只在開源版的 plugin（見 [design/background-screen.md](design/background-screen.md)）：Android 放在 `android/app/src/oss/`，列在 `Edition.kt`，不在 `MainActivity` 註冊；iOS 放在 `ios/AgentScreen/`，列在 `Edition.swift`，只由 `MainViewController` 的 `EditionPlugins` seam 載入。上架版沒有它，`native.has` 回 false。`test/plugins-node.ts` 掃兩個平台的開源版方法與 registry；`test/code-rules.ts` 把 private XCTest symbols 限在 `ios/AgentScreen/`。

## 工具總圖

<!-- 工具總圖：node --import ./test/vite-imports.js test/tools-node.ts --update 產生，不要手改 -->

每個開關（工具組）後面是它的工具，由工具自己宣告的 groups 決定，和擴充無關。＊需要時載入，†直接提供，其他只給腳本。不含 MCP 服務。

- **網路**（`web`）：`web_search`、`web_fetch`
- **天氣**（`weather`）：`weather`
- **台股**（`tw_stocks`）：`tw_stocks`
- **地點**（`places`）：`find_places`
- **手機狀態**（`device`）：`device_info`、`get_location`、`read_sensors`、`get_travel_time`
- **手機 App**（`apps`）：`set_alarm`、`open_alarms`、`set_timer`、`compose_email`、`compose_sms`、`open_maps`、`open_link`、`share`
- **日曆**（`calendar`）：`read_calendar_events`、`list_calendars`、`add_calendar_event`、`delete_calendar_event`
- **聯絡人**（`contacts`）：`contacts`
- **相片**（`photos`）：`find_photos`、`view_photos`＊
- **通話與簡訊**（`calls_sms`）：`call_log`、`read_sms`
- **健康**（`health`）：`health`
- **螢幕使用時間**（`screen_time`）：`screen_time`
- **手機控制**（`phone_control`）：`media`、`do_not_disturb`、`sound`、`display`、`flashlight`、`connections`
- **瀏覽器**（`browser`）：`read_page`、`use_browser`
- **代你操作 App**（`phone_as_user`）：`phone_open_as_user`†、`phone_read_as_user`＊、`phone_act_as_user`＊、`phone_note_as_user`＊
- **通知**（`notifications`）：`read_notifications`、`reply_notification`、`dismiss_notifications`
- **資料庫**（`database`）：`sql`
- **語音**（`speech`）：`speak`
- **GitHub**（`github`）：`github_api`、`github_read_file`
- **Google Cloud**（`gcp`）：`gcp_api`
- **Cloudflare**（`cloudflare`）：`cloudflare_api`
- **Azure**（`azure`）：`azure_api`
- **電腦畫面**（`computer_as_user`）：`computer_read_as_user`＊、`computer_act_as_user`＊
- **電腦上的 agent**（`computer_agents`）：`list_agents`、`read_agent`、`tell_agent`、`answer_agent`
- **電腦**（`computer_shell`）：`read`†、`write`†、`edit`†、`bash`†
- **檔案**（`files`）：`read`†、`write`†、`edit`†、`bash`†
- **固定開著**（沒有開關）：`read_skill`、`save_skill`†、`read_attachment`＊、`scan_document`、`codemode`†、`create_schedule`、`schedule_followup`、`list_schedules`、`delete_schedule`、`notify`、`note_item`、`list_items`、`update_memory`†、`ask_user`†、`tool_search`†

<!-- 工具總圖結束 -->

## 工具清單

每一個工具都要列在這裡（`test/tools-node.ts` 會檢查）。「改動」：**唯讀**；**開畫面**＝打開畫面讓使用者完成；**直接**＝直接改。「結構化」＝有給腳本用的結構化輸出。模型怎麼拿到每個工具，見上面〈怎麼管理〉。

| 工具 | 工具組 | 做什麼 | 改動 | 結構化 |
|---|---|---|---|---|
| `device_info` | 手機狀態 | 電量、網路、勿擾、耳機、儲存空間 | 唯讀 | |
| `get_location` | 手機狀態 | 目前位置和地址 | 唯讀 | |
| `read_sensors` | 手機狀態 | 氣壓、方位、光線、距離感測 | 唯讀 | |
| `get_travel_time` | 手機狀態 | 開車、走路、騎車的距離和時間 | 唯讀 | |
| `weather` | 天氣 | 逐小時和逐日預報 | 唯讀 | ✓ |
| `tw_stocks` | 台股 | 上市櫃股票的盤後資料：每日股價、三大法人買賣超、融資融券、本益比／股價淨值比／殖利率、最新月營收，以及大盤（加權、櫃買指數、成交值、三大法人金額）（證交所、櫃買中心） | 唯讀 | ✓ |
| `find_places` | 地點 | 附近的店家，或用名字找分店 | 唯讀 | ✓ |
| `sql` | 資料庫 | 手機上的 SQLite | 直接 | ✓ |
| `set_alarm` | 手機 App | 設鬧鐘 | 直接 | |
| `open_alarms` | 手機 App | 打開時鐘的鬧鐘清單，讓使用者關掉或刪除鬧鐘（app 不能改時鐘裡的鬧鐘）；手機畫面開著時，模型可以在那個畫面用 `phone_act_as_user` 自己刪 | 開畫面 | |
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
| `sound` | 手機控制 | 鈴聲模式（響鈴、震動、靜音）和各種音量 | 直接 | |
| `display` | 手機控制 | 亮度、自動亮度、自動旋轉、螢幕關閉時間（要「修改系統設定」） | 直接 | |
| `flashlight` | 手機控制 | 手電筒 | 直接 | |
| `connections` | 手機控制 | Wi‑Fi（含網路名稱）、藍牙、行動數據、飛航、定位、NFC、省電；開關只能打開系統面板，手機畫面開著時自己按 | 直接或開畫面 | |
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
| `delete_calendar_event` | 日曆 | 刪活動；重複的活動預設只刪那一次，使用者要求才刪整個系列 | 直接 | |
| `codemode` | 程式模式 | 用腳本一次呼叫多個工具 | 依呼叫的工具 | |
| `web_search` | 網路 | 搜尋 | 唯讀 | |
| `web_fetch` | 網路 | 讀網頁；內容要跑 JS 才出現時，在看不見的 WebView 裡渲染（`render`，或文字少於 300 字時自動）；`save_to` 把檔案下載進 Bot 的資料夾 | 唯讀；`save_to` 直接寫進自己的資料夾 | |
| `github_api` | GitHub | GitHub REST API | `GET` 唯讀，其他直接 | ✓ |
| `github_read_file` | GitHub | 讀 repo 裡的檔案 | 唯讀 | |
| `gcp_api` | Google Cloud | Google Cloud REST API | 讀取唯讀，寫入直接 | ✓ |
| `cloudflare_api` | Cloudflare | Cloudflare REST API | 讀取唯讀，寫入直接 | ✓ |
| `azure_api` | Azure | Azure REST API | 讀取唯讀，寫入直接 | ✓ |
| `phone_read_as_user` | 代你操作 App | 手機自己的畫面：前景 app、元件 id、文字、狀態與中心座標，要的時候加截圖；無障礙服務 | 唯讀 | |
| `phone_open_as_user` | 代你操作 App | 在 Bot 自己的背景螢幕開一個 App（沒有背景螢幕就在使用者的畫面），回傳開好的畫面，並載入 `phone_read_as_user`、`phone_act_as_user`，不必 `tool_search`；直接提供 | 唯讀 | |
| `phone_note_as_user` | 代你操作 App | Bot 記下自己在某個 App 學到的做法（東西在哪、走得通的路徑、怪癖），每個 App 一則、存在這個 Bot 的技能資料裡（`BotSkillsDoc.apps`），附上當時的 App 版本；之後提到那個 App 的訊息會附上它；空白刪除；排程觸發時拒絕；由 `phone_open_as_user` 一起載入 | 直接 | |
| `phone_act_as_user` | 代你操作 App | 一次跨多個畫面：開 app、依 id／文字／座標點、等待文字、捲到文字、確認 app／文字、長按、滑、打字與按鍵；做完回傳變動行，大幅改變才回完整畫面；`note` 顯示在背景螢幕預覽 | 直接 | |
| `read_page` | 瀏覽器 | 這個 Bot 自己的瀏覽器開著的那一頁：網址、看得到的元件（角色、文字、中心座標）、頁面文字，要的時候加截圖 | 唯讀 | ✓ |
| `use_browser` | 瀏覽器 | 一次多個步驟（開網址、點、打字、清空、按鍵、捲動、上一頁、等某段文字出現或消失），做完回傳頁面；`hand_over` 交給使用者登入或處理驗證碼，交還後接著做 | 直接 | ✓ |
| `computer_read_as_user` | 電腦畫面（只在有電腦的 Bot） | 電腦螢幕的截圖，加上前景 app、視窗標題、游標位置 | 唯讀 | |
| `computer_act_as_user` | 電腦畫面（只在有電腦的 Bot） | 一次多個滑鼠、鍵盤步驟，做完回傳截圖 | 直接 | |
| `list_agents` | 電腦上的 agent（只在有電腦的 Bot） | 電腦上 Herdr、Rex 裡的 coding agent，和 `bash` 轉到背景的指令（`job:<id>`）：id、哪個 agent、狀態、資料夾、標題、正在做什麼 | 唯讀 | |
| `read_agent` | 電腦上的 agent（只在有電腦的 Bot） | 一個 agent 的狀態和終端機最後幾行；背景指令是結束碼和輸出最後幾行 | 唯讀 | |
| `tell_agent` | 電腦上的 agent（只在有電腦的 Bot） | 交辦任務給閒著的 agent，多行也當成一則送出 | 直接 | 工作中、等使用者、狀態不明時拒絕 |
| `answer_agent` | 電腦上的 agent（只在有電腦的 Bot） | 替使用者回答 agent 在等的批准或問題：從畫面讀出選項，用方向鍵移到第幾個再按 Enter | 直接 | 排程叫醒的那一輪拒絕；「不要再問」「自動模式」要 `stop_asking` |
| `read`、`write`、`edit`、`bash` | 電腦或檔案 | Bot 的資料夾：選了電腦時在電腦上，沒有時在手機上（`files/`：原生資料夾加 just-bash）；pi-durable 的 coding tools。直接模式的電腦上，`bash` 跑超過 10 秒就轉到背景（`src/jobs/`），對話裡那一行顯示「背景執行中」和停止鈕，跑完叫醒 Bot，最多 2 小時 | 直接，只在 Bot 自己的資料夾裡 | `bash` |
| `read_attachment` | 固定開啟 | 讀附件的其他段落、頁數、搜尋，或把 PDF 頁面轉成圖 | 唯讀 | |
| `scan_document` | 固定開啟 | 打開掃描畫面，掃完變成附件 | 開畫面 | |
| `read_skill` | 固定開啟 | 讀一份 skill | 唯讀 | |
| `save_skill` | 固定開啟 | 把使用者要的做法存成這個 Bot 自己的 skill；排程觸發時不能存 | 直接（每次都是一個看得到的步驟） | |
| `create_schedule` | 固定開啟 | 新增排程（時間或事件） | 直接 | |
| `schedule_followup` | 固定開啟 | 稍後自己回來看 | 直接 | |
| `list_schedules` | 固定開啟 | 這個 Bot 的排程 | 唯讀 | |
| `delete_schedule` | 固定開啟 | 刪排程 | 直接 | |
| `notify` | 固定開啟 | 發通知 | 直接 | |
| `update_memory` | 固定開啟 | 改 MEMORY.md | 直接（每次都是一個看得到的步驟） | |
| `note_item` | 固定開啟 | 記下、更新、結案一筆所有 Bot 共用的事項（要做、在等、完成），`next_at` 到了叫醒負責的 Bot；在等的回覆來了也會叫醒（`wake_app`、`wake_contains`） | 直接 | 見 [design/life-items.md](design/life-items.md) |
| `list_items` | 固定開啟 | 列出還沒結案的事項，預設只有這個 Bot 的 | 唯讀 | |
| `tool_search` | 固定開啟 | 載入需要時才載入的工具 | 唯讀 | |
| `ask_user` | 固定開啟 | 問使用者一個問題，附 2–4 個點一下就回答的選項（對話裡的問題卡，也可以直接打字）；回答就是使用者的下一則訊息，見 [research/references.md](research/references.md) | 唯讀 | |

## 新工具上線前

0. **照介面規範寫**，用 `defineAppTool`（宣告 `effect`、`needs`，需要時寫 `reach`），加進 `catalog.ts` 和上面的工具清單，再跑 `npm run check`；第一次會說是新工具，確認後用 `--update` 加進快照。用到新的原生方法時，先照〈原生 plugin〉加進 contract，兩個平台各自實作。
1. **量測前後**：在 S24 上跑 `test/device/tool-cost.sh <DevTools port> [mcp-<server> ...]`，加入新工具前後各跑一次，記下這組工具的字元數，以及短請求的提示大小變化。
2. **決定載入方式**：照上面的原則，在 `defineAppTool` 設好 `reach`。
3. **用一般人的說法實測**：在 S24 上用暫時的 Bot 問 2–3 題，不提工具名稱，也不說「用 codemode」。記下有沒有用對工具、呼叫了幾次、花了幾秒、答案對不對。
   - 需要時載入的工具，要確認模型會自己用 `tool_search` 載入，或改用其他能完成工作的工具，而不是憑記憶回答。
   - 會寫入的工具，用測試資料確認寫對了，測完復原。
4. **更新這份文件**：更新下面的表格，並在「紀錄」加一行。

## 目前的量測

2026-10-22 的量測，當時工具全部直接提供；2026-10-23 改成程式模式為主之後，每次請求的大小見〈紀錄〉，這張表等重新量過再更新。

2026-10-22，S24，GPT 6.1 Sol。暫時的 Bot 開著全部內建工具（MCP 服務那兩列是 2026-10-21 另外量的）。tokens 是用字元數 ÷ 4.9 估計的；這個比例是實測得到的：24,495 字元的定義讓請求多了 5,029 tokens。

| 工具組 | 擴充 | 載入 | 工具數 | 字元 | 約 tokens |
|---|---|---|---:|---:|---:|
| 排程（固定開啟） | `schedules` | 常駐 | 5 | 3,845 | 785 |
| 手機 App | `apps` | 常駐 | 7 | 3,132 | 639 |
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

設定 › MCP › 瀏覽服務列出的服務（`src/mcp/catalog.ts`），都在 2026-10-21 從 Mac 實際試過：要嘛不用登入就能連，要嘛 OAuth 接受動態註冊，而且接受 pi 的本機跳轉網址（`http://127.0.0.1:47823/oauth/mcp`）。

- **跳轉網址的選擇**：30 個知名服務中，只有 13 個接受 App 的自訂網址（`dev.geminixiang.pimobile:/oauth/mcp`），接受本機網址的有 22 個，而且前面那 13 個也都在裡面。所以登入一律用本機網址（`LoopbackPlugin.kt`）。
- **不在市集裡的**：GitHub、HubSpot、Box 不支援動態註冊；Figma 拒絕註冊（回 403）。
- **加入市集前**：照「新工具上線前」的流程量測。不用登入的服務可以直接從 Mac 量工具定義（`tools/list`）；要登入的，連接後用 `test/device/tool-cost.sh` 量。在 S24 上實際登入並用一般說法問過的，標成「已實測」。

不用登入的服務，工具定義的大小（全部都是需要時載入）：

| 服務 | 工具數 | 標成唯讀 | 字元 | 約 tokens |
|---|---:|---:|---:|---:|
| Context7 | 2 | 2 | 4,938 | 1,008 |
| DeepWiki | 3 | 0 | 1,054 | 215 |
| Exa | 2 | 2 | 2,081 | 425 |
| Hugging Face | 4 | 4 | 7,899 | 1,612 |
| Cloudflare 文件 | 2 | 2 | 998 | 204 |
| Shibui Finance | 12 | 11 | 10,192 | 2,080 |
| 台股開放資料 | 10 | 10 | 22,200 | 4,531 |

工具有沒有標成唯讀（`readOnlyHint`）只影響對話恢復時會不會重跑：唯讀的可以重跑，其他的不會。

## 紀錄

這裡只留介面變更、設計決定與量測基準；2026-11-16 以前逐筆實測流水帳在 git 歷史。新增工具或刻意更動快照時，在最上方補一列寫明原因與量測。

| 日期 | 變更與設計理由 | 提示／快照成本 | 依據與備註 |
|---|---|---|---|
| 2026-11-25 | **電腦上的 agent 跨所有配對電腦**：`list_agents` 同時問每台配對電腦（每台約 4 秒，沒回的只佔一行），id 帶電腦（`<電腦>/<id>`，電腦是 Tailscale 名稱的第一段），`read/tell/answer_agent` 與等它做完的 watch 依 id 的電腦送；不帶電腦的舊 id 仍指 Bot 自己的電腦，存著的 watch 不用遷移。背景指令只列執行中與結束一小時內的；Rex agent 的名字先用視窗標籤。提示說明不用 ssh、兩個都符合時用 `ask_user` 問。快照改動：`agent` 參數說明換成帶電腦的例子（原本的 `rex:c834ae` 例子是錯的格式），`list_agents` 說明改寫（[design/computer-agents.md](design/computer-agents.md)） | `TOOL_CHARS`：`list_agents` 557 → 551、`read_agent` 540 → 533、`tell_agent` 760 → 753、`answer_agent` 827 → 820；`computer_agents` 段落 447 → 634 字元（上限 800） | `test/computer-agents.ts`、`test/contracts/computer-agents.ts`；S24 實測（GPT-6.1 Sol，Bot 在 Mac mini，兩台 Mac 已配對）：清空對話後短請求的提示 5,173 → 5,210 tokens；「切過去 Air 看」144 秒、20 次呼叫並用 ssh → 24 秒、2 次呼叫、沒有 ssh；「pi-linux 拆 kernel lock 那個進度」24 → 19 秒，不再混進另一個 agent；「pi-mobile 那個」有兩個符合時改用 `ask_user` 選項問 |
| 2026-11-16 | **跟錢相關硬擋＋非金錢送出確認**：原生層偵測畫面金額與密碼欄一律停下回 `held`（不經模型，[research/agent-payments.md](research/agent-payments.md)）；非金錢送出由分類器／主模型判斷，未講明對象內容時用「送出這次／不要」單次放行。**iPhone 操作與瀏覽器**：`type` 支援 `id` 直接寫入不叫鍵盤、元素 id 改穩定路徑、WebKit 放大偏移前送 AX `scrollToVisible`；iOS 新增 `Browser` 外掛（`WKWebsiteDataStore`、`RealTouch` seam，[design/browser.md](design/browser.md)） | `TOOL_CHARS`：`phone_act_as_user` 2,322 → 2,232；`plugins.snapshot.json` iOS 方法 69 → 80 | S24（Play 商店擋下 113 ms、密碼欄 3/3 擋下、送出判斷約 +0.7 s）與 iPhone 12 Pro（NT$990 擋下、httpbin 表單 id 全程不變）實測 |
| 2026-11-15 | **`phone_open_as_user` 常駐入口＋`phone_note_as_user` 自學筆記**：入口直接提供並用 `loads` 展開同組，每則使用者訊息比對已安裝 App 附自學筆記（不放系統提示以保快取前綴）。**手機操作與背景螢幕**：穩定 id、`wait_for`、`scroll_to`、`expect`、`screen: background\|front`（[design/background-screen.md](design/background-screen.md)）。**`save_skill` 與 `SKILL.md` 格式**：對齊 pi coding agent `<available_skills>`，`save_skill` 直接提供（排程無人在場拒絕）。**iOS 開源版 `PhoneScreen` 改用 in-process XCTest**（不開 VPN／WDA，缺 DDI 回 `ddi_missing`） | `phone_open_as_user` 78 tokens、`on-demand` 110 → 115 tokens、`phone_act_as_user` +142 字元；`save_skill`＋`skills` 段落短請求全開 4,428 → 4,814 tokens（+386） | `test/contracts/app-notes.ts`、`test/contracts/skills.ts`、`test/phone-screen-steps.ts`；工具快照加 `description_chars` 與雙向 `TOOL_CHARS` ratchet |
| 2026-11-14 | `ask_user` 新增 `shows` 呈現待核准全文（避免模型只寫進檔案不給看）；移除 `ToolFilterExtension`（`tool_search` 只從已套用 `tools.remove` 的 `deferred` 挑） | `ask_user` 約 +60 tokens | `test/contracts/interaction.ts`、`test/contracts/where.ts` |
| 2026-11-13 | **建議回覆 `↳`**（非工具，`replies` 段落，回答文字與通知摘要自動剝除）與**預設作息**（`morning-brief`／`daytime-check` 技能；新 Bot 頭兩則訊息後附提議，放系統提示時模型不照做，[design/triggers.md](design/triggers.md)） | `replies` +398 字元（約 +81 tokens）；預設作息新 Bot 頭兩則 +102 tokens、舊 Bot +32–42 tokens | `test/contracts/rhythm-offer.ts`、模擬器與 S24 實測 |
| 2026-11-10–12 | **電腦畫面三平台文字優先**：新增 Linux（X11／Wayland）與 Windows 後端，改以無障礙樹文字與固定 id 為主、截圖為備案、長邊 1,280 → 1,024、背景操作與焦點等待（[research/computer-use.md](research/computer-use.md)）。**直接模式 `bash` 超 10 秒轉背景**（取代 `run_command`），電腦指令一律走 held session | 電腦畫面三平台 tokens −34%～−46%；拿掉 `run_command` 約 −120 tokens（電腦 Bot 首次輸入 4,313 tokens） | 三平台實測、`test/jobs.ts`、`test/computer-agents.ts`（含 Windows `hc`） |
| 2026-11-09 | **工具開關與擴充脫鉤**：工具宣告 `groups`、`Bot.off` 只存工具組 id、`BotToolsets` 投影成 `tools.remove`、`appSection.about` 跟著工具走（[design/toolset-preferences.md](design/toolset-preferences.md)） | 預設提示快照不變；移除 `test/extensions.snapshot.json` | `test/contracts/where.ts`、`test/contracts/bots.ts`、`test/toolsets.ts` |
| 2026-11-07–08 | 電腦 agent 防線（`src/computer-agents/guard.ts`＋Jev，[research/manager-eval.md](research/manager-eval.md)）；`codemode` 的 `scriptHint` 引導模型改由腳本呼叫 | 不變 | 假工人題組 Qwen3.6 安全失敗 6 → 0 |
| 2026-11-05 | `read_page`／`use_browser` 改只給腳本並加結構化輸出（`image(r.screenshot)` 顯示截圖）；`returnLast` 避開多敘述吃掉後續呼叫；精簡手機 `gh` 只留 `api` 與 `auth status` | codemode +75 字元、on-demand 少一行 | S24 瀏覽器查詢輸入 784k → 210k tokens（呼叫 15 → 8） |
| 2026-11-04 | **`interaction` 擴充**：`ask_user` 問題卡（當時 pi-durable 無工具結束回合機制，採下一則訊息模式）、MCP 2026-07-28 無狀態確認卡（`mcp-stateless.ts`，待上游 #10416 支援後換掉）、結果卡（天氣／`.html` 頁）、手機權限卡 `asks`。升級 pi 1.5.0（參數驗證改 pi-schema）；`System.network` 繞過 Tailscale VPN 假在線 | `ask_user`＋結果卡＋開場規則合計全開 3,821 → 4,206 tokens | `test/contracts/{interaction,mcp-confirm,permissions}.ts` |
| 2026-11-02–03 | **提示段落全面加 `appSection` 上限**（修正已刪 Bot 滯留造成 300 個名字進提示）；`*_as_user` 命名與 `opens: "screen"`／`effect: "screen"` 檢查；`web_fetch` 改先經 `Page.check` 擋憑證錯誤與 Safe Browsing；MCP 不覆寫同名內建工具 | 首次請求 4.1k → 2.4k tokens；新增 `test/prompt.snapshot.json` | `test/prompt.ts`、`test/contracts/{where,mcp}.ts` |
| 2026-10-31 | 固定開啟「事項」（`note_item`、`list_items`，[design/life-items.md](design/life-items.md)）；新工具組「電腦上的 agent」（`list/read/tell/answer_agent`，[design/computer-agents.md](design/computer-agents.md)）；無人值守規則由系統提示搬到觸發訊息尾（放系統提示時模型不照做） | 事項約 +60 tokens；電腦 agent +68 tokens（S24 實測）；排程系統提示 −40 tokens | `test/items.ts`、`test/computer-agents.ts`、S24 實測 |
| 2026-10-29–30 | **弱模型友善與快取**：`oneOf` 改 `enum`（錯誤列出全部允許值，Qwen3.6 驗證）、`returnLast` 自動補 `return`（Qwen3.6 10 題 383s → 226s、空結果 14 → 0 次）、參數自動轉型、加 `weekday` 欄位、送出時間注入使用者訊息（不再呼叫 `device_info`、跨午夜不破快取）。新工具組「瀏覽器」（`page-controller`＋原生 `isTrusted` 觸控，[design/browser.md](design/browser.md)） | 工具快照 75,870 → 67,951 bytes（−10%）；每則使用者訊息時間戳約 +10 tokens | `test/tool-args-node.ts`、`test/codemode-scripts.ts`、S24 實測 |
| 2026-10-26–28 | 新工具組「台股」（`tw_stocks`，+15 tokens；美股走 MCP 市集不自寫）、「手機控制」補齊讀寫對稱（[design/phone-state.md](design/phone-state.md)）；`defineAppTool` 統一宣告 `reach`/`effect`/`needs` 與 `src/plugins/` 合約快照；新增 `delete_calendar_event`、`open_alarms`（三星鬧鐘無法由 API 刪除） | 全開 3,546 → 3,777 tokens（`tool-cost.sh`）；新增 `test/plugins.snapshot.json` | S24 與 iPhone 12 Pro 實測 |
| 2026-10-24–25 | 新工具組「代你操作 App」（原「手機畫面」），預設只回元件清單、`screenshot: true` 才截圖（−28% 輸入 tokens，[research/phone-screen.md](research/phone-screen.md)）；排程加入 `guards`、`only_if` 與系統事件；手機資料夾加入 `git`/`gh`（token 不進 bash） | 畫面工具按需載入；清單版 968k → 697k tokens（15/15） | S24 實測、`test/bash/run.ts` |
| 2026-10-23 | **改為程式模式為主**（僅 7 個工具直接提供、看圖按需載入、其餘含 MCP 只給腳本）；拿掉通用核准機制；自寫 `pi-mobile mcp computer` 取代 `computer-use-mcp`（[research/computer-use.md](research/computer-use.md)） | 首次輸入 GPT 8,799 → 3,373 tokens、Claude 12,596 → 2,433 tokens | S24 實測（全部答對，每題輸入降約 40–70%） |
| 2026-10-21–22 | 初始基準（全部常駐 6,920–8,103 tokens、全關 2,488 tokens）；MCP 改按需載入且預設不開；`defineAppTool` 參數清理與結構化輸出；系統提示加平行呼叫規則；`web_fetch` 加 `render`／PDF／`save_to`；手機資料夾改用 just-bash Worker（[research/just-bash.md](research/just-bash.md)） | 全開 8,103 / 全關 2,488 tokens（2026-10-22 S24） | `test/tools-node.ts`、`test/device/tool-cost.sh` |

