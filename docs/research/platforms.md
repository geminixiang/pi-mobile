# 研究：pi mobile 搬到 iOS、macOS、Windows、Linux

2026-10-24 查的，來源以官方文件和規格為主。這裡記的是查到的事實；各功能在各平台的對照表見 [design/platforms.md](../design/platforms.md)。全部都還沒在真的裝置上驗證過。

## 外殼

| | Capacitor（現在用的） | Tauri 2 | Electron |
|---|---|---|---|
| 官方支援的平台 | Android、iOS、Web。桌面沒有官方支援[^cap-platforms] | Windows、macOS、Linux、Android、iOS[^tauri-webviews] | Windows、macOS、Linux |
| WebView | 系統的 | 系統的：WebView2、WKWebView、WebKitGTK、Android System WebView[^tauri-webviews] | 自帶 Chromium |
| 原生程式碼 | Java/Kotlin、Swift | Rust；行動平台的 plugin 可以用 Kotlin 或 Java，以及 Swift[^tauri-plugins] | Node |
| 繞過 CORS 的串流 HTTP | 沒有：`CapacitorHttp` 不能串流，要自己寫（我們的 `StreamFetch`）[^caphttp] | 有：`plugin-http` 2.4.1 以上，請求在 Rust 端發出[^tauri-http] | 有（Node） |
| 大小 | — | 最小的 app 不到 600 KB；Windows 沒有 WebView2 時，安裝程式會另外下載[^tauri-size] | 壓縮後通常 80–100 MB[^tauri-size] |

- Capacitor 的社群 Electron 平台（`capacitor-community/electron`）已經寫明不再維護，最後一版是 2023-09。它的 README 改推 Capawesome 的 Electron 平台（`@capawesome/capacitor-electron`，第三方）。只有 Android 實作的 plugin，在那裡不會自動能用[^cap-platforms][^capawesome]。
- Tauri 的 Android plugin 可以用 Java，但介面是 Tauri 自己的（`@TauriPlugin`、`@Command`），所以現有的 Capacitor plugin 不能直接搬過去，要改寫外面那層[^tauri-plugins]。

## 背景執行

- **iOS**：app 進背景後很快會被暫停，不能指望 `WKWebView` 裡的 JavaScript 繼續跑[^ios-bg]。可以用的機制：
  - `beginBackgroundTask`：多要一點時間把手上的事做完，不是長期[^ios-bg-time]。
  - `BGAppRefreshTask` 最多 30 秒。`BGProcessingTask` 只在裝置閒置時跑，使用者一拿起手機就會被中止。兩種都是由系統決定什麼時候跑，`earliestBeginDate` 的意思是「不早於」，不是「準時」[^ios-bgtasks]。
  - **`BGContinuedProcessingTask`（iOS 26）**：使用者在前景**親手開始**的工作，離開 app 後可以繼續，系統用 Live Activity 顯示進度，使用者可以取消。它不能在背景中開始一件新的工作[^ios-continued]。這是 iOS 上唯一跟「Bot 正在做事，我先切出去」對得上的機制。但 WebKit 的網頁內容跑在另一個 process，那個 process 會不會跟著活著，**要實際量**。
- **macOS**：被移出視窗的 `WKWebView` 預設會被暫停（`inactiveSchedulingPolicy` 預設是 `.suspend`），macOS 14 以上可以設成 `.none`。不在前景的頁面，計時器也會被 WebKit 節流[^mac-wk-sched]。
- **Windows**：WebView2 的 `IsVisible = false` 時，計時器會被節流，但不會停。`TrySuspendAsync` 才會讓它停下[^wv2-bg]。

## 系統資料和控制

### iOS
- 通知：`UNUserNotificationCenter` 只看得到自己 app 的通知，讀不到別的 app 的[^ios-notif]。
- 通話紀錄、簡訊：一般的第三方 app 讀不到。CallKit 只管 app 自己的通話[^ios-calls]。
- 螢幕使用時間：`DeviceActivityReport` 的資料只能留在 report extension 裡面，那裡連網路都不能用。extension 只能回傳一個畫面，原始數字拿不出來[^ios-screentime]。
- 媒體控制：`systemMusicPlayer` 只能控制 Apple Music，控制不了 Spotify 這類其他 app[^ios-media]。
- 專注模式：`INFocusStatusCenter` 只能讀，不能開關[^ios-focus]。
- 鬧鐘、計時器：iOS 26 的 **AlarmKit**，可以排一次性鬧鐘、重複鬧鐘、倒數計時，在靜音和專注模式下也會響[^alarmkit]。
- 感測器：`CMAltimeter` 有氣壓[^ios-alti]。
- 掃描文件：VisionKit 的 `VNDocumentCameraViewController`[^visionkit]。
- 語音轉文字：iOS 26 和 macOS 26 的 `SpeechAnalyzer` / `SpeechTranscriber` 在裝置上轉文字，模型要先下載[^speechanalyzer]。
- 觸發：
  - 地理圍欄：取得「一律允許」位置權限時，進出某個區域可以把已經關掉的 app 在背景叫起來[^ios-region]。
  - Shortcuts 個人自動化：可以設成「立即執行」，去跑 app 提供的 App Intent。觸發條件包括時間、打開某個 app、NFC、Wi-Fi、電量。但 intent 如果需要前景互動，還是會打斷[^shortcuts]。

### macOS
- 通知：沒有公開 API 能讀別的 app 的通知。只能用輔助使用 API 去讀螢幕上的通知 UI，這只是盡力而為的繞路[^mac-notif]。
- 媒體控制：從 15.4 起，私有的 MediaRemote 不再讓第三方讀取「正在播放」；也沒有控制其他 app 的公開 API[^mac-mediaremote]。
- 健康：Mac 上沒有 HealthKit 資料庫，`isHealthDataAvailable()` 回 `false`[^mac-health]。
- 照片：PhotoKit 可以用[^mac-photos]。
- 掃描文件：透過「接續互通相機」，要有 iPhone[^mac-continuity]。
- 控制滑鼠鍵盤：要「輔助使用」和「傳送事件」兩種權限，兩者是分開的[^mac-events]。
- 事件：
  - 藍牙連線：`IOBluetoothDevice` 有連線通知，這是公開 API[^mac-bt]。
  - 解鎖：`com.apple.screenIsUnlocked` 可以用，但**不在官方文件裡**[^mac-unlock]。
- Share Extension：不上 Mac App Store 也能做，只有 extension 本身要開 sandbox[^mac-share]。

### Windows
- 通知：`UserNotificationListener` 可以讀別的 app 的通知，但 app 要有 **package identity**（MSIX，或 sparse package），並由使用者同意[^win-notif]。
- 媒體控制：`GlobalSystemMediaTransportControlsSessionManager` 可以控制。只看得到有接上系統媒體控制的 app[^win-media]。
- 勿擾：沒有一般 app 能用的開關。Focus session 的 API 是 Limited Access Feature，要向 Microsoft 申請。目前的通知模式只能讀[^win-dnd]。
- 聯絡人：`ContactStore` 沒有被淘汰，但要 package identity[^win-contacts]。
- 行事曆：舊的「郵件與行事曆」2024-12-31 停止支援。新版 Outlook 有沒有接 `AppointmentManager`，官方沒有說明，有開發者回報叫不出畫面。實際上要改走 Microsoft Graph[^win-calendar]。
- 位置：沒有 package 的 app 也能用 `Geolocator`，執行時再要權限[^win-geo]。
- 語音轉文字：`Windows.Media.SpeechRecognition` 的自由聽寫**要連網**[^win-speech]。
- 分享目標：要 package identity[^win-share]。
- 解鎖事件：`WTSRegisterSessionNotification` 的 `WTS_SESSION_UNLOCK`[^win-unlock]。

### Linux
- 通知：在 session bus 上用 `BecomeMonitor` 可以看到別的 app 送出的 `Notify`，只能讀。Flatpak 這類 sandbox 會擋[^linux-notif]。
- 媒體控制：MPRIS 2.2，D-Bus 上的標準[^mpris]。
- 金鑰：Secret Service API（libsecret 是它的客戶端），要看有沒有裝實作它的服務[^secret-service]。
- 位置：GeoClue（D-Bus）[^geoclue]。
- 解鎖、電量：logind 的 `Session.Unlock` 訊號，UPower 的 `Percentage`[^logind]。
- 控制滑鼠鍵盤（Wayland）：RemoteDesktop portal 先跳出視窗讓使用者同意，再用 libei 送輸入[^wayland-input]。
- WebKitGTK：
  - Web Locks 從 2.36 起有[^webkitgtk-locks]。Tauri 2 用的是 webkit2gtk-4.1 API。「4.1」是 API 版本，不是引擎版本，Ubuntu 22.04 的更新版已經是 2.50[^tauri-linux]。
  - `speechSynthesis` 從 2.40 起有，用 Flite，但要看發行版編譯時有沒有打開[^webkitgtk-tts]。
  - WASM 有 JIT。慢的話先分清楚是運算慢還是重繪慢[^webkitgtk-wasm]。

## 發佈

- **iOS**：
  - 沒有像 APK 那樣自己裝的方式。TestFlight 每個 build 最多 90 天，外部測試者最多 10,000 人，要經過審核。Ad hoc 每年最多 100 台 iPhone，要先登記裝置[^ios-dist]。這兩種都要付費的 Apple Developer Program。
  - 審核規則 2.5.2 禁止下載程式碼來改變 app 的功能。4.7 准許 HTML5 / JavaScript 的 mini app，但有條件[^appstore-rules]。pi 的 code mode 和 skills 會執行模型寫的程式，**要先評估會不會卡審核**。
- **macOS**：在 App Store 之外發佈，要 Developer ID 簽章加上公證（notarization），Gatekeeper 才會用預設設定打開[^mac-notary]。
- **Windows**：簽章之後會顯示發行者名稱，但 SmartScreen 還要看信譽，新簽的 app 一開始還是可能跳警告[^win-smartscreen]。讀通知、聯絡人、分享目標都要 package identity，所以最好一開始就用 MSIX 打包。

[^cap-platforms]: https://capacitorjs.com/docs/getting-started/environment-setup ；https://github.com/capacitor-community/electron
[^capawesome]: https://capawesome.io/docs/sdks/capacitor/electron/ ；https://github.com/capawesome-team/capacitor-electron
[^tauri-webviews]: https://v2.tauri.app/reference/webview-versions/
[^tauri-plugins]: https://v2.tauri.app/develop/plugins/ ；https://v2.tauri.app/develop/plugins/develop-mobile/
[^caphttp]: https://github.com/ionic-team/capacitor/blob/main/core/http.md
[^tauri-http]: https://v2.tauri.app/reference/javascript/http/
[^tauri-size]: https://tauri.app/start/ ；https://v2.tauri.app/distribute/windows-installer/
[^ios-bg]: https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background
[^ios-bg-time]: https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time
[^ios-bgtasks]: https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app ；https://developer.apple.com/documentation/backgroundtasks/bgtaskrequest/earliestbegindate
[^ios-continued]: https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask ；https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados/ ；https://developer.apple.com/videos/play/wwdc2025/227/
[^mac-wk-sched]: https://developer.apple.com/documentation/webkit/wkpreferences/inactiveschedulingpolicy-swift.property ；https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/
[^wv2-bg]: https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.isvisible ；https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.trysuspendasync
[^ios-notif]: https://developer.apple.com/documentation/usernotifications/unusernotificationcenter
[^ios-calls]: https://support.apple.com/en-us/102515 ；https://developer.apple.com/documentation/identitylookup/sms-and-mms-message-filtering
[^ios-screentime]: https://developer.apple.com/documentation/deviceactivity/deviceactivityreport ；https://developer.apple.com/documentation/deviceactivity/deviceactivitymonitor
[^ios-media]: https://developer.apple.com/documentation/mediaplayer/mpmusicplayercontroller/systemmusicplayer
[^ios-focus]: https://developer.apple.com/documentation/intents/infocusstatuscenter/focusstatus
[^alarmkit]: https://developer.apple.com/documentation/AlarmKit ；https://developer.apple.com/videos/play/wwdc2025/230/
[^ios-alti]: https://developer.apple.com/documentation/coremotion/cmaltimeter
[^visionkit]: https://developer.apple.com/documentation/visionkit/vndocumentcameraviewcontroller
[^speechanalyzer]: https://developer.apple.com/videos/play/wwdc2025/277/ ；https://developer.apple.com/documentation/speech/speechtranscriber
[^ios-region]: https://developer.apple.com/documentation/CoreLocation/requesting-authorization-to-use-location-services ；https://developer.apple.com/documentation/corelocation/cllocationmanager/startmonitoring(for:)
[^shortcuts]: https://support.apple.com/en-gb/guide/shortcuts/apd602971e63/ios ；https://developer.apple.com/design/human-interface-guidelines/app-shortcuts
[^mac-notif]: https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getdeliverednotifications(completionhandler:) ；https://developer.apple.com/documentation/applicationservices/axuielement_h
[^mac-mediaremote]: https://github.com/feedback-assistant/reports/issues/637 ；https://developer.apple.com/documentation/mediaplayer/mpremotecommand
[^mac-health]: https://developer.apple.com/documentation/healthkit/about-the-healthkit-framework
[^mac-photos]: https://developer.apple.com/documentation/photos ；https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.personal-information.photos-library
[^mac-continuity]: https://developer.apple.com/documentation/appkit/supporting-continuity-camera-in-your-mac-app
[^mac-events]: https://developer.apple.com/documentation/coregraphics/cgrequestposteventaccess() ；https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions
[^mac-bt]: https://developer.apple.com/documentation/iobluetooth/iobluetoothdevice/register(forconnectnotifications:selector:)
[^mac-unlock]: https://github.com/Hammerspoon/hammerspoon/blob/master/extensions/caffeinate/libcaffeinate_watcher.m ；https://developer.apple.com/documentation/foundation/distributednotificationcenter
[^mac-share]: https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionCreation.html
[^win-notif]: https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener
[^win-media]: https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager
[^win-dnd]: https://learn.microsoft.com/en-us/uwp/api/windows.ui.shell.focussessionmanager ；https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanagerforuser.notificationmode
[^win-contacts]: https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.contacts.contactstore ；https://learn.microsoft.com/en-us/windows/whats-new/deprecated-features
[^win-calendar]: https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.appointments.appointmentmanager ；https://learn.microsoft.com/en-us/graph/api/calendar-post-events
[^win-geo]: https://learn.microsoft.com/en-us/windows/apps/develop/maps-and-location/get-location
[^win-speech]: https://learn.microsoft.com/en-us/windows/apps/develop/input/speech-recognition
[^win-share]: https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/integrate-sharesheet-receive ；https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps
[^win-unlock]: https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsregistersessionnotification
[^linux-notif]: https://xdg.pages.freedesktop.org/xdg-specs/notification/latest/protocol.html ；https://dbus.freedesktop.org/doc/dbus-specification.html
[^mpris]: https://specifications.freedesktop.org/mpris/latest/
[^secret-service]: https://specifications.freedesktop.org/secret-service/latest-single/ ；https://gnome.pages.gitlab.gnome.org/libsecret/libsecret-simple-api.html
[^geoclue]: https://www.freedesktop.org/software/geoclue/docs/ref-dbus.html
[^logind]: https://freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html
[^wayland-input]: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html
[^webkitgtk-locks]: https://commits.webkit.org/244850@main
[^tauri-linux]: https://v2.tauri.app/start/prerequisites/
[^webkitgtk-tts]: https://webkitgtk.org/2023/03/17/webkitgtk2.40.0-released.html ；https://github.com/WebKit/WebKit/blob/main/Source/cmake/OptionsGTK.cmake
[^webkitgtk-wasm]: https://v2.tauri.app/reference/webview-versions/ ；https://v2.tauri.app/develop/debug/linux-graphics/
[^ios-dist]: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/ ；https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/
[^appstore-rules]: https://developer.apple.com/app-store/review/guidelines/ ；https://developer.apple.com/support/terms/apple-developer-program-license-agreement/
[^mac-notary]: https://support.apple.com/guide/security/sec3ad8e6e53/web
[^win-smartscreen]: https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation
