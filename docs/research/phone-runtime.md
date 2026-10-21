# 手機 runtime 能給 agent 用的功能

2026-10-22 在 S24 上實測：Android 16（API 36），Android System WebView 155（Chromium 155），Snapdragon 8 Gen 3（Adreno 750），8 GB RAM，8 核。pi 的頁面 origin 是 `http://localhost`，算安全環境（`isSecureContext`），但沒有 cross-origin isolation。

分兩層：WebView 自己的 Web API（agent 在 JS 裡直接用，不用寫原生程式），和 Android 原生 API（要寫 Capacitor 外掛）。「有這個物件」不等於能用，下面都是實際呼叫過的結果。

## WebView：實測能用

| 功能 | 結果 | 可以做什麼 |
|---|---|---|
| `BarcodeDetector` | QR 解碼 283 ms；支援 QR、Data Matrix、PDF417、Aztec、EAN、UPC、Code 128/39/93 等 13 種 | 讀照片或附件裡的 QR code、條碼（發票、Wi‑Fi、網址）。模型自己看圖解不出 QR |
| WebGPU | Adreno 750，`shader-f16`，單一 buffer 上限 2 GB；100 萬個數的運算 56 ms | 在手機上跑模型：文字 embedding（語意搜尋筆記、通知、附件）、Whisper 語音轉文字、OCR |
| WebGL2 | Adreno (TM) 750 | 同上，舊路徑 |
| OPFS 與同步存取 | 主執行緒寫 20 MB 148 ms、讀 72 ms；Worker 的 `createSyncAccessHandle` 寫入 1.2 GB/s；配額 10.7 GB（剩 48 GB 時）；`persist()` 一律 false，屬於「盡力保存」 | Bot 的工作資料夾、SQLite wasm |
| WebCodecs | H.264 編碼、Opus 編碼都支援；`ImageDecoder` | 錄音壓縮、影片取幀給模型看 |
| `MediaRecorder`、`getUserMedia` | 有麥克風、相機、喇叭 | 錄音（需要 WebView 權限處理，見下） |
| 感測器 | `Accelerometer` 讀到 (0.1, 0, 9.7)；`Gyroscope`、`AbsoluteOrientationSensor` | 已有原生 `read_sensors` |
| Screen Wake Lock | 可以拿到 | 長時間執行時不讓螢幕關 |
| Contact Picker | `navigator.contacts.getProperties()` 回 email、name、tel、address、icon | 使用者點一下選聯絡人交給 agent，app 不必有讀取全部聯絡人的權限。要使用者手勢 |
| `navigator.connection`、`getBattery` | wifi／4g、電量 83% | 已有原生 `device_info` |
| 其他 | `CompressionStream`、`crypto.subtle`、`Intl.Segmenter`、`Temporal`、`scheduler.postTask`、`Sanitizer`、`WebTransport` | Code mode 的工具箱 |

## WebView：有物件但不能用

| 功能 | 結果 | 原因與替代 |
|---|---|---|
| `SpeechRecognition` | `not-allowed` | WebView 不把麥克風權限交給它；已用原生 `VoicePlugin` |
| `NDEFReader`（NFC） | `NFC permission request denied` | WebView 沒有這個權限的 UI；要原生 |
| `showOpenFilePicker` | 要使用者手勢 | 可以用，但 `<input type=file>` 已經夠 |
| `IdleDetector` | 要使用者手勢 | 用處不大 |

沒有的：`speechSynthesis`（已用原生 `speak`）、`navigator.share`（已用原生分享）、`Notification`、Web Bluetooth／USB／Serial／HID、`SharedArrayBuffer`（沒有 cross-origin isolation，所以 wasm 不能開多執行緒）、Chrome 的內建 AI（`Translator`、`Summarizer`、`LanguageModel`）。

## 手機上已有的系統服務

`dumpsys package` 查到：AICore、Google Play 服務 26.41、Android System Intelligence、Google TTS、Samsung TTS、Google 翻譯、Google 相簿、Samsung 圖庫、Samsung Health 7.0、Health Connect（模組版本 17）。硬體：NFC、指紋、氣壓計、光感、距離感測、計步器、BLE、電話。

**Gemini Nano 不能用**：S24 不在 ML Kit GenAI 的 Prompt API 和 Summarization API 支援清單上（[ML Kit GenAI](https://developers.google.com/ml-kit/genai)）。S24 上的 Gemini Nano 只給 Google 訊息用；Samsung Notes 等的摘要走雲端 Gemini Pro（[Google 公告](https://blog.google/products-and-platforms/platforms/android/google-ai-samsung-galaxy-s24/)）。ML Kit 的非生成式功能（OCR、翻譯、條碼、文件掃描）不受這個限制。

## Android 原生：還沒給 agent 的

依「使用者會怎麼說」排列。權限欄：**已有**＝現在的權限就夠；**一般**＝一般執行期權限；**特殊**＝要使用者到系統設定開。

| 功能 | 使用者會說 | Android API | 權限 |
|---|---|---|---|
| 控制正在播的音樂、看在播什麼 | 「暫停音樂」「現在在放哪首」 | `MediaSessionManager.getActiveSessions`（用通知讀取的 listener 當憑證） | 已有（通知存取） |
| 回覆、清除通知 | 「回 LINE 給媽媽說我晚點到」 | 通知的 `RemoteInput` 動作、`cancelNotification` | 已有（通知存取）；送出要核准 |
| 勿擾模式 | 「開勿擾到明早 7 點」 | `NotificationListenerService.requestInterruptionFilter` | 已有（通知存取） |
| 聯絡人 | 「傳簡訊給小明」「誰的生日快到了」 | `ContactsContract` | 一般：`READ_CONTACTS` |
| 找照片 | 「上週在台南拍的照片」「昨天拍的收據」 | `MediaStore`（日期、EXIF 地點、相簿） | 一般：`READ_MEDIA_IMAGES`（Android 14 起可以只給部分） |
| 來電紀錄、簡訊 | 「剛剛誰打給我」「驗證碼多少」 | `CallLog`、`Telephony.Sms` | 一般：`READ_CALL_LOG`、`READ_SMS`（上架 Play 受限，自己裝沒問題） |
| 健康資料 | 「我這週睡得怎樣」「今天走幾步」 | Health Connect（Samsung Health 要開同步） | 一般：Health Connect 各類別 |
| 螢幕使用時間 | 「我今天滑手機多久」 | `UsageStatsManager` | 特殊：使用情況存取 |
| 叫出 pi 時看目前畫面 | 長按電源鍵：「這頁在講什麼」「幫我回這封」 | 設成數位助理（`VoiceInteractionService`），叫出時系統給畫面截圖和文字結構 | 特殊：使用者選 pi 當預設助理。只有使用者叫出時才拿得到畫面 |
| 新的觸發 | 「到家時提醒我」「連上公司 Wi‑Fi 時」「開始充電時」「碰一下 NFC 貼紙」 | Geofencing（Play 服務）、`ConnectivityManager` callback、電源廣播、NFC 前景分派 | 到家要背景定位（特殊）；其他一般 |
| 手機上的 OCR、翻譯 | 掃描 PDF 給不看圖的模型、離線翻譯 | ML Kit Text Recognition v2（含中文）、ML Kit Translation | 不用權限；模型要下載 |
| 文件掃描 | 「掃一下這張合約」 | ML Kit Document Scanner（系統的掃描介面，輸出 PDF/JPEG） | 不用權限 |
| 指紋核准 | 寫入、付款前按指紋 | `BiometricPrompt` | 不用權限 |
| 操作其他 app | 「幫我在 Uber 叫車」 | Accessibility Service | 特殊，而且風險高；先不做 |

## 做了哪些（2026-10-22）

| 功能 | 工具／入口 | commit |
|---|---|---|
| 回覆、清除通知；音樂；勿擾 | `reply_notification`、`dismiss_notifications`、`media`、`do_not_disturb` | `6d7762f` |
| 聯絡人、相片 | `contacts`、`find_photos`、`view_photos` | `288ef37` |
| QR／條碼 | 圖片交給模型時自動解碼（不是工具） | `aec545f` |
| 通話與簡訊、螢幕使用時間；pi 當數位助理 | `call_log`、`read_sms`、`screen_time`；長按側邊鍵 | `2b82083` |
| 新的觸發：充電、Wi‑Fi、到達／離開地點 | `create_schedule` 的 `on` | `72cb324` |
| 文件掃描、掃描頁 OCR | `scan_document`、迴紋針 › 掃描文件 | `9c8c208` |
| 健康 | `health`（Health Connect 系統 API） | `b7aa83b` |
| 指紋核准；鎖屏核准要先解鎖 | 設定 › 帳號 › 核准時驗證 | `22a0f9c` |

沒做的：

- **離線翻譯**（ML Kit Translation）：模型本身就會翻譯，而且翻得比較好；每種語言還要下載約 30 MB。只有完全沒網路時有用。
- **NFC 貼紙觸發**：要先把 pi 的網址寫進貼紙，Android 才會在 pi 沒開時把碰觸交給它；手邊沒有貼紙可以測。
- **操作其他 app**（Accessibility）：風險高，數位助理已經涵蓋「看目前畫面」這個最常見的需求。
- **WebGPU 上的模型**：等需要語意搜尋或離線語音轉文字時再做。

實作時學到的：

- **觸發的機制**：「插上電源」的廣播不再送給沒在執行的 app，改用要求充電的 JobScheduler 工作，自己判斷是不是新的一次充電；Wi‑Fi 用要求 Wi‑Fi 網路的工作（帶 PendingIntent 的網路 callback 在第一次送出 5 秒後就被系統移除）；地點用 `LocationManager.addProximityAlert`，設定後系統會先回報「目前在圈內或圈外」，那不算事件。
- **數位助理**：`startAssistantActivity` 會在另一個 assistant task 開第二個 MainActivity（第二個 WebView）；改從 session 直接開 pi 自己的 task。
- **受限制的設定**：不是從 Play 商店安裝的 app，使用情況存取權和數位助理要先在應用程式資訊頁「允許受限制的設定」。
- **Health Connect**：Android 14 起是系統 API，Java 直接呼叫；但 app 要有回應「為什麼需要健康資料」的 intent，系統才會顯示權限畫面。
- **MediaStore**：EXIF 地點要從原始檔讀（`setRequireOriginal` 加 `ACCESS_MEDIA_LOCATION`）；查詢參數一律當文字綁定，數字比較要寫進 SQL。

## 原本的建議順序

1. **通知存取已經開了，就順便多做三件事**：音樂控制、回覆／清除通知、勿擾模式。不用新權限，都是每天會說的話。
2. **聯絡人和照片**：讓現有的簡訊、email、附件能用名字找人、用描述找照片。
3. **QR／條碼**：`BarcodeDetector` 在 WebView 裡就有，不用新套件，可以做成讀附件照片的工具。
4. **叫出 pi 看目前畫面**：做成數位助理。比 Accessibility 安全，因為只有使用者叫出 pi 時才看得到畫面，可能是手機 agent 最自然的入口。
5. 健康、螢幕時間、來電／簡訊、新的觸發：價值高，但要使用者開權限，一個一個來。
6. WebGPU 上的模型（embedding、Whisper）：等需要語意搜尋或離線語音轉文字時再做。
