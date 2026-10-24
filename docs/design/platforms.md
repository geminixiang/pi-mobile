# 各平台能做到什麼

狀態：2026-10-24 整理，只是盤點。現在以 Android 開發為主，這張表用來在寫 Android 功能時，順便知道它在別的平台會落在哪一格。

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

## 規劃上要先決定的事

1. **外殼**：Capacitor 官方只支援 Android 和 iOS，社群的 Electron 平台已經不維護。Tauri 2 一套程式碼可以出五個平台，`plugin-http` 也已經能做繞過 CORS 的串流；代價是原生層要改寫成 Tauri plugin（Android 那邊可以繼續用 Java）。
2. **iOS 做到什麼程度**：通知、通話紀錄和簡訊、螢幕使用時間都拿不到；背景執行只有 `BGContinuedProcessingTask` 一條路。要先在真的 iPhone 上量 WebKit 會不會跟著活，再決定 iOS 值不值得做。
3. **資料**：同一個 Bot 在手機和電腦上是兩份，還是要同步。

## 寫 Android 功能時

- **地基**（第 1 節）：新的原生能力如果每個平台都需要，介面放在 `Platform`（`src/agent/platform.ts`），不要在功能程式裡直接 `registerPlugin`。現在直接呼叫的有 35 個檔案，之後要慢慢收進去。
- **工具**：新工具在第 2 節加一列。只有 Android 做得到的也沒關係，以後由 [capabilities.md](capabilities.md) 讓沒有這個能力的平台看不到這個工具。現在是呼叫時才失敗（`requireNative()`）。
- **寫死 Android 的地方**：給模型的提示（`triggers.ts`、`apps.ts`、`common.ts`），以及 `web.ts` 的 User-Agent。新寫的提示說「這支裝置」就好，不要寫「Android」。
