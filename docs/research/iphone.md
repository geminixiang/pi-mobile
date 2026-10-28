# iPhone 實機：能用的 API、感測器，和 pi 的工具

2026-10-28 第一次在 iPhone 上實測。裝置是 iPhone 12 Pro（`iPhone13,3`，iOS 27.0.1），開了「放大顯示」，所以頁面寬 320 點。它用 USB 接在 MacBook Air 上，連線方式見 `.pi/skills/device-testing/SKILL.md`。

API 是用一個暫時的偵測 plugin 量的：它只編進這次的 debug build，沒有進 repo。偵測只讀可用與否和授權狀態，不跳權限詢問。工具則是在暫時的 Bot 裡，用 codemode 逐一呼叫。

## 硬體和系統 API

### 不用權限就能用

| 項目 | 量到的 |
|---|---|
| 加速度計、陀螺儀、磁力計 | 都有，`CMMotionManager` 直接讀得到原始值，不用權限（平放時加速度約 (0, 0, −1) g） |
| 距離感測器 | 有：`UIDevice.isProximityMonitoringEnabled` 打得開，讀得到 `proximityState` |
| 電池、溫度、省電 | 電量、充電狀態、`thermalState`、低耗電模式 |
| 螢幕 | 亮度讀得到，`UIScreen.brightness` 也能設定；最高 60 fps；原生 1170×2532 |
| 聲音 | 目前輸出音量、輸出裝置（喇叭、耳機、藍牙）、麥克風清單；不能改音量 |
| 相機 | 廣角（前後）、超廣角、望遠、三鏡頭、TrueDepth、LiDAR 深度相機；有手電筒（`hasTorch`） |
| ARKit | 世界追蹤、LiDAR 網格、場景深度、臉、人體、地理追蹤 |
| UWB（U1） | 精確距離、方向、相機輔助，要另一台 UWB 裝置才有東西量 |
| Face ID | `canEvaluatePolicy` 為真，可以用來保護敏感動作 |
| VisionKit / Vision | 文件掃描（`VNDocumentCameraViewController`）、即時文字掃描（`DataScannerViewController`）、圖片分析；文字辨識支援繁中、簡中、日、韓等 33 種語言 |
| 網路 | Wi‑Fi／行動網路、是否計量、是否受限；拿不到 Wi‑Fi 名稱 |
| 剪貼簿 | 只能知道有沒有文字、網址、圖片；讀內容時系統會問「允許貼上」 |

### 要使用者授權

| 項目 | 狀態 |
|---|---|
| 位置（`CLLocationManager`） | 精確位置、方位、明顯位置變化、地理圍欄、iBeacon 都支援；測試時給了「使用 App 期間」 |
| 氣壓、計步、樓層、步速、步頻、活動類型（`CMAltimeter`、`CMPedometer`、`CMMotionActivityManager`） | 都支援，要「動作與健身」權限；測試時給了 |
| 行事曆、聯絡人、照片 | 測試時都給了完整取用 |
| AlarmKit | 測試時給了。pi 可以列出、取消自己設的鬧鐘和計時器 |
| 提醒事項、Apple Music 資料庫、藍牙 | 都還沒問過，要先在 Info.plist 加說明 |
| 語音辨識 | `SFSpeechRecognizer` 的 zh-TW 可用，也能在裝置上辨識；pi 現在用的 `SpeechAnalyzer` 只要麥克風權限 |

### 要 entitlement，現在拿不到

- **Siri**：沒有 Siri entitlement 時，`INPreferences.siriAuthorizationStatus()` 會讓 App 直接被中止（SIGABRT），不是回一個狀態。要讓 Siri 叫得到 pi，應該走 App Intents。
- **專注模式狀態**（`INFocusStatusCenter`）：要 entitlement，沒有呼叫。
- **NFC**：`readingAvailable` 回 false。iPhone 12 Pro 有 NFC，但要先加 NFC 讀取的 entitlement。
- **健康**：`HKHealthStore.isHealthDataAvailable()` 為真，但要加 HealthKit entitlement，再由使用者授權。
- **限時通知**（time-sensitive）：回「不支援」，要 entitlement。
- **Wi‑Fi 名稱**、**WeatherKit**、**螢幕使用時間**（Family Controls，要 Apple 核准）：都要另外申請。

### 這支做不到

- **Apple Intelligence 的裝置上模型**（Foundation Models）：回 `deviceNotEligible`，要 iPhone 15 Pro 以上。
- **環境光感測器**：沒有公開 API。
- **行動網路類型**：`serviceCurrentRadioAccessTechnology` 回空的。
- **其他 app 的資料和操作**：別的 app 的通知、通話紀錄、簡訊、操作別的 app 的畫面、開關勿擾、改鈴聲模式，都沒有 API（見 [platforms.md](platforms.md)）。

## pi 的工具在 iPhone 上

63 個工具裡，原生方法 iOS 都有實作的有 41 個。其餘 22 個 iOS 沒有：通知、手機畫面、媒體和聲音等控制、通話紀錄和簡訊、使用時間、健康、掃描文件、排程、`notify`、`open_alarms`。GitHub、GCP、Cloudflare、Azure 這幾組沒出現，因為 iPhone 上沒設帳號；電腦組也沒出現，因為沒選電腦。

**正常的**：

- **手機狀態、位置、地點**：`device_info`、`get_location`（松山區，精度 14 m）、`read_sensors`（氣壓 1017.5 hPa、方位 NW）、`get_travel_time`（走路、開車）、`weather`、`find_places`。
- **資料**：`tw_stocks` 六種資料、`sql`（SQLite 3.54.0）、`contacts`、`find_photos`、`view_photos`、`read_skill`、`web_search`、`web_fetch`（含 `render` 和 `save_to`）。
- **資料夾**：`write`、`read`、`edit`、`bash`。
- **開別的 App 或畫面**：
  - `open_link`：打開 Safari。
  - `open_maps`：打開 Google Maps 的大眾運輸路線。
  - `compose_sms`：在 pi 裡彈出 iMessage 撰寫畫面。
  - `share`：分享畫面，帶著資料夾裡的檔案。
- **會發聲的**：`set_alarm`、`set_timer` 建立成功（建好立刻取消）；`speak` 在音量 0 時回報講完。
- **行事曆**（寫在 iCloud 的「工作」「居家」，和 Google 帳號的「映翔 趙」，兩邊結果一樣）：
  - 單一活動和整天活動。
  - start 對不上、id 不存在：兩種都正確報錯。
  - 重複活動只刪一次、刪單獨改過的那一次。
  - 刪整個系列：從第一次、中間改過的那次、第一次就改過的那次刪，都對。
  - 自然問句（GPT-6.1 Sol）：「2027 年 1 月 8 號那個牙醫的行程幫我刪掉」42 秒；「3 月 9 號那次的週會不用開了」36 秒，只取消那一次；「週會以後都不開了，整個刪掉」20 秒；「把明天早上 5:20 的鬧鐘刪掉」17 秒，回答做不到，請使用者到時鐘 App 關。
- **畫面**：320 點寬時沒有任何一頁會整頁左右捲動，長網址以省略號收尾。

**測試中修好的**：

- **刪除整個系列**：iOS 上單獨改過的那一次，id 是系列的 id 加 `/RID=<時間>`，外部 id 也一樣，EventKit 沒有別的屬性連回系列。原本從它刪「整個系列」時，只刪了它之後的幾次，前面的留著，工具卻回報「每一次都刪了」。現在先去掉後綴找到系列，從第一次刪起；找不到就報錯。
- **往上捲時內容跳動**：訊息之前的 `content-visibility: auto` 讓畫面外的訊息先用 320 點的佔位。WebKit 要等訊息露出畫面才畫它，Chrome 提早半個畫面；所以 iPhone 上換成真實高度的那一刻，它下面的內容整段被推開。手動捲 9.5 秒的記錄裡有 20 次（320 → 743、320 → 30…），捲動位置一次都沒被補正。現在 iOS 不用 `content-visibility`（`data-platform="ios"`）。
- **捲軸被蓋住**：可以左右捲的程式碼區塊是獨立圖層；WebKit 在捲動區裡判斷重疊很保守，排在它們後面、`position: relative` 的工具列，和半透明的「… 前面 N 行」也都被提升成滿版圖層，蓋過 iOS 的捲軸。程式碼區塊改成自動換行（跟 pi-tui 一樣），工具列的「開啟」按鈕改用 grid 疊放，半透明改成 `color-mix`；對話裡已經沒有獨立圖層。
- **從程式碼區塊開始滑會閃一下**：提問泡泡按下時用 `filter: brightness()`，iOS 一碰就套 `:active`，`filter` 又把整個泡泡提升成圖層。改成延遲 90 ms 的內陰影。
- **提問泡泡太高**：泡泡的 `white-space: pre-wrap` 讓 Markdown 結構之間的換行也顯示成空行，清單的編號自己一行。現在只有段落保留換行。
- **開關側欄卡 50 到 70 ms**：Base UI 的 Drawer 在打開時、以及其他覆蓋層打開時，對包著整個主畫面的滑動區設 `pointer-events: none`。這個屬性會繼承，5,000 個節點的對話要整個重算樣式：CPU 全速時 11 ms，閒置降頻時就是 50 到 70 ms，對話越長越卡。同樣是 Base UI，從按鈕、連結、輸入框開始的滑動一律不算，這份清單寫死在 `useSwipeDismiss`。側欄改成自己的手勢後，同一個對話裡程式開關 3 次，閒置時最慢 26 ms（原本 74 ms，超過 50 ms 的幀從 7 次變 0 次）；拖動 396 幀最慢 18 ms；從連結、按鈕上開始滑都拉得出來。手動測時記錄到的另一半頓挫，是 CPU 閒置降頻：同樣的開關，主執行緒保持忙碌就不卡。
- **側欄的樣子照 X**：使用者拿 X 當比較對象。在同一支 iPhone 上用 Instruments 的 Animation Hitches 錄，同樣上下捲動、開關側欄：X 42 秒裡 App 自己卡了 4 次（最長 83 ms，另有影片播放和系統畫面 8 次），pi 30 秒裡 0 次，兩邊每秒都是 60 個畫面。差在樣子：X 的選單不是蓋上來，而是把整個主畫面推開，主畫面成為圓角卡片、帶陰影，選單從底下帶一點縮放推上來。pi 現在也這樣做。放手後的動畫先用 CSS transition、再用 Web Animations，兩種都在 iPhone 上出現過「DOM 說已經開了（或關了），畫面卻停在半路」：動畫被拖動接手後，WebKit 的合成器留著舊的 transform。改成由程式逐幀設定位置後，連續打斷 5 種情況的壓力測試，畫面和 DOM 都一致。圓角和陰影只在側欄出現時才有：一直保留的話，鍵盤彈出時主畫面的下緣會露出圓角。另外，有一段時間 iPhone 和 Xcode 的連線不正常（`Failed to allocate RSD device`，重開 MacBook Air 上的 `CoreDeviceService` 才恢復），那段時間量到的開關每次卡 85–115 ms，連線恢復後同一版只有 25–33 ms；異常時的數字不能用。
- **手感退步是判定規則，不是畫面**：為了「太靈敏、會從左側欄滑到右側欄」，一次改了 6 個地方：起算距離 14 px、甩動要 0.5 px/ms 而且移動超過一成、關閉後 0.4 秒不接受、收合中擋板還吃觸控、220 ms。使用者覺得手感整個變差；同時量放手後每一幀都是 16–17 ms，畫面沒有卡。改回 S24 上手感好的那套（10 px、0.35 px/ms、260 ms，收合一開始就放行）後恢復。一次只改一項，改完先讓人試。
- **格線讓卡片每動一幀都重畫**：在模擬器上錄追蹤紀錄，數每一段的 `Paint` 和 `RasterTask`。格線是卡片自己的背景時，卡片每移動一幀，Chrome 都把整片格線重新點陣化（31 幀 366 個 tile）；拿掉圓角或位移取整數都沒用，改由 `.app::before` 畫格線後是 4 個。整個開關流程裡，拖開的重新點陣化從 95–153 降到 20，拖回關上從 145 降到 1，放手後的動畫降到 0。iPhone 上拖動每幀接近 24 ms，很可能是同一個原因，還沒在 iPhone 上確認。
- **被推開的卡片把整頁撐寬**：卡片往右推出 354 px，頁面內容變成 767 px 寬，Android WebView 把版面視窗放大到 767×1563，關上後也不縮回；`position: fixed` 的元素和用 `innerHeight` 算座標的測試都跟著錯位。`.root` 加 `overflow: clip` 後維持 412×840。
- **停住再放手不該甩出去**：放手時用的是最後幾筆移動的速度，手指停住後不會再有移動事件，所以拉到四成、停住、放開，還是照停住前的速度甩開。現在放手前 100 ms 內沒有移動就當作沒有速度。

**還沒改的問題**：

1. **背景跑不下去**：pi 離開前景後，它的網頁內容約 1 秒內就被暫停，回到前景才接著跑，不會失敗。
   - 量法：在前景搜尋完、打開 Safari，再連續抓 60 次網頁。三次都一樣：離開後最多再抓幾次，之後就停到回前景。開了 WebView 的 `inactiveSchedulingPolicy = .none` 也一樣。
   - 背景接續工作確實在跑：前景有系統的進度橫幅；系統紀錄裡 `BGContinuedProcessingTask` 從送出跑到回合結束，pi 的 App 一直是「背景執行中」，沒有被暫停。
   - 停的是 WebKit：pi 一離開畫面，App 裡 WebKit 的 `ProcessThrottler` 就對網頁內容的 process 送出 `PrepareToSuspend`（`remainingRunTime=0`），接著允許系統暫停它。
   - 這跟 iPad 的結果相反：[design/platforms.md](../design/platforms.md) 記錄 iPad（iPadOS 26.7）上 8 次有 7 次在背景跑完。差在 iOS 27 還是 iPhone，這次分不出來。
   - 要在 iPhone 上背景跑，agent 可能得移出 WebKit，例如放到 App 自己 process 裡的 JavaScriptCore；動手前先在 iPad 升 iOS 27 後重量一次。
2. **進度橫幅蓋住標題列**：在沒有動態島的 iPhone 上，`BGContinuedProcessingTask` 的系統橫幅整個回合都蓋在 pi 的標題列上，遮住 Bot 名稱和資料夾按鈕。
3. **行事曆權限狀態不更新**：剛給完行事曆權限時，`EKEventStore.authorizationStatus` 在同一次執行裡還是回「沒問過」，重開 pi 才變成已允許。這段時間「設定 › 手機」的行事曆只顯示「讀取帳號清單」按鈕。
4. **`compose_email` 沒有寄信帳號時**：「郵件」App 沒設帳號時，pi 改開 `mailto:`，結果停在「郵件」的加入帳號畫面，草稿不見了。有 Gmail App 時，可以改開它。
5. **`read_sensors` 漏了距離感測**：iOS 有距離感測器，但工具回報 `proximity` 讀不到；光線則確實沒有 API。
6. **工具說明照 Android 寫**：模型在 iPhone 上看到的說明，有些內容 iOS 給不出來：
   - `device_info` 寫了 Wi‑Fi 名稱、鈴聲模式、勿擾、電池溫度。
   - `read_sensors` 寫了光線。
   - 電腦組的錯誤訊息叫模型改用 `read_phone_screen`，但 iPhone 沒有這個工具。
7. **帳號名稱**：行事曆的帳號在設定裡顯示成「iCloud（CalDAV）」。
8. **Google 的節日日曆當成自己的**：Google 帳號裡的「Holidays in Taiwan」在 iOS 是一般的 CalDAV 日曆（唯讀），pi 只排除「訂閱」和「生日」類型，所以把它當成使用者自己的日曆，節日會出現在使用者的行程裡。Android 把它當成別人分享的。Google 帳號裡別人分享的日曆可能也一樣。
9. **帳號用名稱分辨**：iOS 的 Google 帳號名稱預設叫「Gmail」，pi 用「類型:名稱」分辨帳號，兩個 Google 帳號都叫「Gmail」時，設定裡的讀寫權限會合在一起。

**iOS 可以補的**（依上面的 API）：

- 手電筒、螢幕亮度：Android 的 `flashlight`、`display` 在 iOS 可以做一部分。
- 距離感測：補進 `read_sensors`。
- 計步、樓層、活動類型。
- 文件掃描：`scan_document`。
- 刪除 pi 自己設的鬧鐘：AlarmKit 可以，Android 反而做不到。
- 提醒事項。
- 大眾運輸的交通時間：MapKit 的 `MKDirections`。
