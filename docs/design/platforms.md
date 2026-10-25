# 各平台能做到什麼

狀態：2026-10-24 整理。pi mobile 主打隨身帶著走的 AI agent，所以**只做 Android 和 iOS，外殼繼續用 Capacitor**。桌面三欄留著參考，現在不做。這張表用來在寫 Android 功能時，順便知道它在 iOS 會落在哪一格。

- **Android** 一欄是現況。
- **其他欄**是依照 [research/platforms.md](../research/platforms.md) 查到的官方文件填的，來源都在那裡，但都還沒在真的裝置上試過。要做某個平台時，先驗證那一欄。

| 記號 | 意思 |
|---|---|
| 有 | Android 上已經做好 |
| 可 | 系統有公開 API，做得到 |
| 部分 | 只做得到一部分，或要繞路（括號裡寫怎麼繞） |
| 無 | 第三方 app 拿不到 |
| 未查 | 還沒查 |

## 1. 地基：每個平台都要先有

這一層不做，app 跑不起來。Android 的實作都是 Capacitor plugin，換平台就要重寫一份。

| 能力 | Android 實作 | iOS | macOS | Windows | Linux |
|---|---|---|---|---|---|
| 串流 HTTP，繞過 CORS（模型串流） | `StreamFetch` | 可（Capacitor 的 `CapacitorHttp` 不能串流，要用 Swift 自己寫） | 可（Tauri `plugin-http` 2.4.1 以上） | 可（同 macOS） | 可（同 macOS） |
| 一般 HTTP，繞過 CORS（MCP、OAuth、`web_fetch`、雲端） | `CapacitorHttp` | 可 | 可 | 可 | 可 |
| 金鑰存放 | Keystore（`capacitor-secure-storage`） | 可（Keychain） | 可（Keychain） | 可（Credential Manager） | 部分（Secret Service，要有實作它的服務） |
| OAuth 的 loopback 回呼 | `Loopback` | 可 | 可 | 可 | 可 |
| Bot 資料夾 | `BotFiles` | 可 | 可（可以直接用真的檔案系統） | 可（同 macOS） | 可（同 macOS） |
| SQLite（`sql` 工具、附件） | `Database` | 可 | 可 | 可 | 可 |
| 開外部連結、剪貼簿、震動 | `System` | 可 | 可（沒有震動） | 可（沒有震動） | 可（沒有震動） |
| 對話存在 IndexedDB、Web Lock | WebView 內建 | 可 | 可 | 可 | 可（WebKitGTK 2.36 以上） |
| Code mode（QuickJS WASM，跑在 Worker 裡） | WebView 內建 | 可 | 可 | 可 | 部分（WebKitGTK 有 WASM JIT，效能要量） |
| **背景繼續跑** | `AgentService` 前景服務 | **部分**（只有 iOS 26 的 `BGContinuedProcessingTask`：使用者在前景開始的工作，離開後可以繼續；WebKit 的 process 會不會跟著活著要量） | 可（WKWebView 要設 `inactiveSchedulingPolicy = .none`） | 可（WebView2 不要設 `IsVisible = false`，否則會被節流） | 未查 |

## 2. 工具

依 `test/tools.snapshot.json` 的工具組排列。

### 不靠裝置，每個平台都一樣

只用 HTTP 或 WebView，地基做好就能用：`codemode`、`web_search`、`web_fetch`、`github_api`、`github_read_file`、`gcp_api`、`cloudflare_api`、`azure_api`、`weather`（Open-Meteo）、`get_travel_time`（OSRM）、`find_places`、`sql`、`update_memory`、`read_skill`、`read_attachment`、`tool_search`、`read`、`write`、`edit`、`bash`、`list_schedules`、`delete_schedule`。

### 靠裝置

| 工具組 | 工具 | Android | iOS | macOS | Windows | Linux |
|---|---|---|---|---|---|---|
| device | `device_info` | 有 | 可 | 可 | 可 | 可 |
| device | `get_location` | 有 | 可 | 可 | 可（不需要打包） | 可（GeoClue） |
| device | `read_sensors` | 有 | 部分（CoreMotion：動作、氣壓） | 無 | 無 | 無 |
| phone_apps | `set_alarm`、`set_timer` | 有 | 可（iOS 26 的 AlarmKit） | 部分（改用通知） | 部分（改用通知） | 部分（改用通知） |
| phone_apps | `compose_email` | 有 | 可 | 可（`mailto:`） | 可（`mailto:`） | 可（`mailto:`） |
| phone_apps | `compose_sms` | 有 | 可（只打開撰寫畫面） | 部分（`sms:` 交給訊息 app） | 無 | 無 |
| phone_apps | `open_maps`、`open_link` | 有 | 可 | 可 | 可 | 可 |
| phone_apps | `share` | 有 | 可 | 可 | 可 | 無 |
| speech | `speak` | 有 | 可 | 可 | 可 | 部分（WebKitGTK 2.40 起有，要看發行版有沒有編進去） |
| notifications | `read_notifications`、`reply_notification`、`dismiss_notifications` | 有 | 無 | 無（只能用輔助使用 API 讀螢幕上的通知） | 部分（只能讀，app 要有 package identity） | 部分（監聽 session bus，只能讀，Flatpak 會擋） |
| phone_control | `media` | 有 | 部分（只能控制 Apple Music） | 無（15.4 起連私有 API 也讀不到） | 可（系統媒體控制） | 可（MPRIS） |
| phone_control | `do_not_disturb` | 有 | 無（只能讀） | 無（只能讀） | 無（要向 Microsoft 申請） | 未查 |
| contacts | `contacts` | 有 | 可 | 可 | 部分（要 package identity） | 未查 |
| photos | `find_photos`、`view_photos` | 有 | 可（PhotoKit） | 可（PhotoKit） | 部分（圖片資料夾） | 部分（圖片資料夾） |
| calls_sms | `call_log`、`read_sms` | 有 | 無 | 無 | 無 | 無 |
| screen_time | `screen_time` | 有 | 無（資料出不了 report extension） | 無 | 無 | 無 |
| health | `health` | 有（Health Connect） | 可（HealthKit） | 無（Mac 沒有 HealthKit 資料） | 無 | 無 |
| attachments | `scan_document` | 有 | 可（VisionKit） | 部分（接續互通相機，要有 iPhone） | 無 | 無 |
| calendar | `read_calendar_events`、`list_calendars`、`add_calendar_event` | 有 | 可（EventKit） | 可（EventKit） | 無（舊系統 API 接不到新版 Outlook，要走 Microsoft Graph） | 未查 |
| triggers | `create_schedule`、`schedule_followup`：時間 | 有 | 部分（背景工作由系統決定時間，不準；準時的只有通知和鬧鐘，要使用者打開 pi 才會跑） | 可（pi 開著時） | 可（同 macOS） | 可（同 macOS） |
| triggers | `create_schedule`：事件 | 有 | 部分（地理圍欄要「一律允許」；其他靠 Shortcuts 自動化去跑 App Intent） | 部分（藍牙連線有公開 API；解鎖沒有官方文件） | 部分（解鎖） | 部分（logind 解鎖、UPower 電量） |
| triggers | `notify` | 有 | 可 | 可 | 可 | 可 |
| computer | `read_screen`、`use_screen` | 有（透過電腦上的 host） | 有（透過 host） | 可（直接控制本機，要「輔助使用」和「傳送事件」權限） | 可（直接控制本機） | 部分（Wayland 要透過 RemoteDesktop portal，使用者每次都要同意） |

## 3. App 本身

| 功能 | Android | iOS | macOS | Windows | Linux |
|---|---|---|---|---|---|
| 語音輸入 | 有 | 可（iOS 26 的 SpeechAnalyzer，在手機上轉） | 可（同 iOS，macOS 26） | 部分（自由聽寫要連網） | 無 |
| 拍照附加 | 有 | 可 | 部分（退回成選檔案） | 部分（同 macOS） | 部分（同 macOS） |
| 從其他 app 分享給 pi | 有 | 可（Share Extension） | 可（Share Extension，不上架也行） | 部分（要 package identity） | 無 |
| 當成系統的數位助理 | 有 | 部分（App Intents，透過 Siri） | 部分（全域快捷鍵） | 部分（全域快捷鍵） | 部分（全域快捷鍵） |
| 版面 | 有（直立手機） | 可（同 Android） | 要做寬螢幕版面、hover、鍵盤 | 同 macOS | 同 macOS |
| 發佈 | GitHub 上的 APK | 只能走 App Store、TestFlight（每個 build 90 天）或 ad hoc（最多 100 台），都要付費帳號；code mode 執行模型寫的程式，要先評估會不會卡審核 | Developer ID 簽章加上公證 | 簽章；SmartScreen 要累積信譽；最好用 MSIX，讀通知和分享目標都要 package identity | 自己打包 |

## 決定

- **只做 Android 和 iOS，外殼繼續用 Capacitor**（2026-10-24）。Capacitor 官方支援的正好是這兩個平台。桌面以後要做，再看 Tauri 2（見研究文件）。電腦的角色仍然是被手機控制的那一台（host）。
- **還沒決定**：同一個人有 Android 和 iPhone 時，Bot 的資料是兩份還是同步。

## iOS 要做的事

### 進度（2026-10-25）

一步一步來，跟 Android 一樣邊用邊加工具，不求第一版就有很多工具。

| 步驟 | 內容 | 狀態 |
|---|---|---|
| 0 | `ios/` 專案，`scripts/run-ios.sh` 在模擬器上建置、安裝、打開 | 做好了 |
| 1 | 啟動時檢查有哪些原生 plugin，沒有的工具不安裝（[capabilities.md](capabilities.md)） | 做好了 |
| 2 | 實機量背景和連電腦（下一節） | 要 iPhone |
| 3 | Swift plugin：`System`、`StreamFetch`、`Loopback` | |
| 4 | Swift plugin：`BotFiles`、`Database` | |
| 5 | 手機功能，一次一個，照 `docs/tools.md` 量過再加 | |

模擬器上現在能用：設定供應商（金鑰存在 Keychain）、對話、code mode、網路搜尋；工具組只有「網路」，時間由 code mode 的 `new Date()` 換算。模擬器的 app 要 ad hoc 簽章（`CODE_SIGN_IDENTITY=-`），不簽的話 Keychain 存不進去（-34018）。

### 先量，量完再決定要不要投入

0. **連電腦**：app 的網址是 `capacitor://localhost`，iOS 預設擋明文 HTTP，要量 `http://100.x`、`ws://` 到電腦端會不會被擋。被擋的話，電腦端改用 Tailscale 發的 `*.ts.net` 憑證走 https。

1. **背景**：用 `BGContinuedProcessingTask` 開始一輪對話，切出 app，量 WKWebView 裡的 agent 會不會繼續跑、能跑多久。如果 WebKit 的 process 會被暫停，iOS 上一輪對話就只能在前景跑完。
2. **審核**：code mode 執行模型寫的程式、skills 從外面下載，對照審核規則 2.5.2 和 4.7，先確認上得了 App Store 或 TestFlight。上不了的話，iOS 只剩 ad hoc（最多 100 台）。

### 地基：用 Swift 寫 Capacitor plugin

| Plugin | iOS 上的做法 |
|---|---|
| `StreamFetch` | `URLSession`，資料一段一段用事件送回 JS（`CapacitorHttp` 不能串流） |
| `Loopback` | 本機 HTTP server 接 OAuth 回呼，或改用 `ASWebAuthenticationSession` |
| `BotFiles` | app 自己的檔案目錄 |
| `Database` | SQLite |
| `System` | 開連結、剪貼簿、震動 |
| `KeepAlive` | 改成 `BGContinuedProcessingTask`，看上面第 1 點量出來的結果 |
| 金鑰 | `capacitor-secure-storage` 本來就支援 iOS（Keychain） |

### 手機功能：做得到的

位置、動作和氣壓感測器（CoreMotion）、鬧鐘和計時器（AlarmKit，iOS 26）、寫信和簡訊（只打開撰寫畫面）、地圖、連結、分享、朗讀、聯絡人、照片（PhotoKit）、健康（HealthKit）、掃描文件（VisionKit）、行事曆（EventKit）、通知、語音輸入（SpeechAnalyzer，iOS 26）、從其他 app 分享給 pi（Share Extension）、Siri（App Intents）。

### 手機功能：做不到的，iOS 上模型看不到這些工具

讀通知、回覆通知、通話紀錄、讀簡訊、螢幕使用時間、勿擾、控制其他 app 的媒體播放（只能控制 Apple Music）。啟動時檢查有哪些原生 plugin（[capabilities.md](capabilities.md)），沒寫的 plugin 對應的工具就不安裝，所以 iOS 上不用特別處理這些。

### 自動化

Android 上的自動化靠系統廣播在背景叫醒 pi，iOS 沒有這種機制。能用的只有：

- **時間**：系統的背景工作不準時。準時的只有通知和 AlarmKit，時間到了提醒使用者，打開 pi 才會跑。
- **地點**：地理圍欄要「一律允許」位置權限，可以把 pi 在背景叫起來，但能跑多久要量。
- **其他事件**：pi 提供 App Intent，由使用者在 Shortcuts 建立個人自動化（時間、打開某個 app、NFC、Wi-Fi、電量）去觸發。

所以 iOS 上的自動化比較像「到時候提醒你，你點一下 pi 就接手」，不是 Android 那種在背景自己跑完。

## 寫 Android 功能時

- **地基**（第 1 節）：新的原生能力如果 iOS 也需要，介面放在 `Platform`（`src/agent/platform.ts`），不要在功能程式裡直接 `registerPlugin`。現在直接呼叫的有 35 個檔案，之後要慢慢收進去。Plugin 的 JS 介面寫成 iOS 也實作得出來的樣子，不要讓 Android 才有的概念（intent、package 名稱、content URI）出現在介面上。
- **工具**：新工具在第 2 節加一列，填上 iOS 那一格。只有 Android 做得到的也沒關係：iOS 沒有那個 plugin，啟動時檢查完就不會安裝這個工具（[capabilities.md](capabilities.md)）。
- **寫死 Android 的地方**：給模型的提示（`triggers.ts`、`apps.ts`、`common.ts`），以及 `web.ts` 的 User-Agent。新寫的提示說「這支裝置」就好，不要寫「Android」。
