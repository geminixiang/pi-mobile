# 背景觸發：平台有什麼，pi 缺什麼

2026-10-31。問題：「pi 被滑掉之後，排程還會跑嗎？Android／iOS 一定有系統的觸發機制，app 不該自己做 cron。」

## 結論

- **觸發本來就交給系統**：pi 的排程沒有自己的計時器。時間用 `AlarmManager`，事件用系統廣播、`JobScheduler`、`NotificationListenerService`、proximity alert（`TriggerStore.kt`、`TriggerEvents.kt`）。pi 被滑掉後，這些照樣觸發（S24 實測）。
- **缺的是「觸發後誰來跑」**：一般 app 被叫醒後跑的是原生程式碼，幾秒就做完。pi 的 agent 是 WebView 裡的 JavaScript（pi-durable、pi-ai、工具），存資料靠 WebView 的 IndexedDB／OPFS，一跑就是幾十秒到幾分鐘。系統叫醒的只有原生部分；WebView 要靠 Activity 才有。
- **Android 的答案**：精確鬧鐘＋「顯示在其他應用程式上層」，從背景把 pi 安靜地叫起來（`design/triggers.md` 方案 C），2026-10-31 已做，S24 和模擬器都實測過。另外改用 `USE_EXACT_ALARM`，排程不再晚到。
- **iOS 的答案**：系統不讓 app 在指定時間在背景跑任意長的工作。能準時的只有「通知」（點了才跑）和 AlarmKit（響鈴），背景工作的時間由系統決定。要真的準時又不用點，只能把 agent 放到伺服器（pi 的情況是使用者的電腦）。

## Android 有的機制

| 機制 | 準時 | 叫醒後能做什麼 | pi 用在哪 |
|---|---|---|---|
| `AlarmManager.setExactAndAllowWhileIdle` | 準時，Doze 中也會響 | 原生廣播；可以啟動前景服務（精確鬧鐘豁免） | 每天、一次性排程 |
| `setAndAllowWhileIdle`（沒有精確鬧鐘權限時） | Android 12 起「在指定時間後一小時內」 | 同上，但前景服務豁免文件只寫精確鬧鐘 | 舊的退路，S24 上晚 40 秒到 1.5 分鐘 |
| `setAlarmClock` | 準時，最高優先 | 狀態列會出現鬧鐘圖示 | 不用：會讓使用者以為有鬧鐘 |
| WorkManager／`JobScheduler` | 不準，最短週期 15 分鐘 | 原生 Worker，最多約 10 分鐘 | 充電、Wi-Fi 事件（輪詢） |
| 系統廣播、`NotificationListenerService`、proximity alert | 事件發生時 | 原生接收器 | 耳機、通知、地點 |
| FCM 高優先推播 | 伺服器決定 | 可以啟動前景服務 | 沒用：要伺服器和 Firebase |

精確鬧鐘權限有兩個（[排程鬧鐘](https://developer.android.com/develop/background-work/services/alarms/schedule)、[Android 14 變更](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms)）：

- `SCHEDULE_EXACT_ALARM`：Android 13 起新安裝不預先給，要使用者到設定打開，使用者和系統都能收回。S24 上就是關的。
- `USE_EXACT_ALARM`：安裝時自動給，不能收回。限制只在 Google Play 的政策（鬧鐘、行事曆類 app）。pi 從 GitHub 發 APK、不上 Play，而且排程都是使用者要求的定時動作，符合它的用途。2026-10-31 起宣告，模擬器確認安裝後 `granted=true`、`canScheduleExactAlarms()` 為 true。

## 被叫醒之後：怎麼讓 WebView 跑起來

| 做法 | 可行性 |
|---|---|
| **A. 程序和 Activity 還在**：直接把事件交給 JS | 已做。只有在 pi 沒被滑掉時有效 |
| **B. 跳通知「點一下開始」** | 已做，是最後的退路 |
| **C. 從背景開 Activity，立刻退到背景** | 已做。依據是[背景啟動 Activity 的例外](https://developer.android.com/guide/components/activities/background-starts)第 4 條「使用者授予 `SYSTEM_ALERT_WINDOW`」，文件沒有版本限制。開了 Activity 之後，再啟動前景服務也在[豁免清單](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)內（「app 可以從背景啟動 Activity」） |
| **D. 前景服務自己建 WebView** | 技術上可行（WebView 可以不掛在 Activity 上），但 Capacitor 的 bridge 綁 Activity，所有 plugin 要另外接一套。成本太高 |
| **E. 另一個 JS 執行環境**（[Capacitor Background Runner](https://github.com/ionic-team/capacitor-background-runner)） | 不行。它不是 WebView：沒有 DOM、IndexedDB、localStorage、WebAssembly，只有 `fetch`、計時器、一個字串 KV；iOS 每次約 30 秒，Android 最多 10 分鐘。pi 的 agent 和它的資料都在 WebView 的儲存裡 |

C 的細節與注意：

- Android 15 起，光有 `SYSTEM_ALERT_WINDOW` 不能從背景啟動前景服務，要畫面上真的有浮動視窗。所以順序是先開 Activity（SAW 例外），再啟動前景服務（「能從背景開 Activity」的豁免）；前景服務失敗不算整個失敗（`TriggerReceiver.startQuietly`）。
- Android 14／15 對 `PendingIntent` 的 BAL 改成要寄送者／建立者明確同意。C 直接在接收器裡 `startActivity`，不經過 `PendingIntent`，不受影響。
- 實測（S24，螢幕亮著、在桌面）：觸發後桌面一直在最前面，沒有閃；agent 跑完、發通知、更新小工具。之後 pi 會再出現在最近使用的 app 裡。
- 還沒測：螢幕關著、鎖定中；省電模式；Samsung 的「休眠中的應用程式」名單（被放進去的 app 連鬧鐘都可能不準）。

## iOS 有的機制

| 機制 | 準時 | 能跑多久 | 說明 |
|---|---|---|---|
| 本機通知（`UNCalendarNotificationTrigger`） | 準時 | 不跑：使用者點了才開 app | 等於 Android 的方案 B |
| `BGAppRefreshTask` | 不準：`earliestBeginDate` 只是下限，系統可能晚很多或不跑 | 約 30 秒 | 看使用習慣、電量排程 |
| `BGProcessingTask` | 不準：通常在充電、閒置時 | 幾分鐘 | 適合整理資料，不適合「早上 8 點」 |
| `BGContinuedProcessingTask`（iOS 26） | 不適用：必須由使用者在前景開始 | 有進度的 Live Activity | 只是讓「使用者剛按下的事」在背景做完 |
| 靜默推播（`content-available`） | 伺服器決定，系統會節流 | 約 30 秒 | 要 APNs 和伺服器 |
| AlarmKit（iOS 26） | 準時 | 全螢幕鬧鐘 UI | 是響鈴提醒，不是背景執行 |
| 捷徑「個人自動化」（時間、抵達、充電、Wi-Fi…） | 準時，iOS 17 起可設「立即執行」不需確認 | 執行 App Intent；可以不開 app（`openAppWhenRun = false`） | 使用者要自己在「捷徑」建自動化；App Intent 是原生程式碼，要跑 WebView 裡的 agent 還是得開 app |

iOS 的設計就是「app 不在前景就不跑使用者看不到的長工作」。所以 ChatGPT 的排程任務是在伺服器上跑，到時間再推播（[Axios](https://www.axios.com/2025/01/14/chatgpt-tasks-openai-ai-assistant)：「不管你有沒有開 ChatGPT 都會執行」）。

## 給 pi 的建議

1. **Android：維持 A → C → B**。C 需要使用者打開一次「顯示於上方」（設定 › 自動化 › 滑掉 pi 也照跑）。精確鬧鐘改用 `USE_EXACT_ALARM`，不用再請使用者打開「準時執行」。
2. **補測 C**：螢幕關著、鎖定、省電模式、隔夜；用一週的 log（`fired … (started quietly)` 與實際完成時間）看涵蓋率。
3. **iOS：先做 B**（本機通知，點了才跑），再評估「排程在電腦上跑」：pi 已經有電腦端（`host/`），電腦整天開著時，排程可以在那裡準時跑，結果寫回手機、推播。需要手機工具（行事曆、照片）的排程仍要等手機。
4. **不做**：Background Runner（跑不了 agent）、自建 WebView 服務（D，成本太高）、`setAlarmClock`（會在狀態列顯示鬧鐘）。

## 來源

- [Schedule alarms（Android Developers）](https://developer.android.com/develop/background-work/services/alarms/schedule)
- [Schedule exact alarms are denied by default（Android 14）](https://developer.android.com/about/versions/14/changes/schedule-exact-alarms)
- [Restrictions on starting activities from the background](https://developer.android.com/guide/components/activities/background-starts)
- [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Changes to foreground services](https://developer.android.com/develop/background-work/services/fgs/changes)
- [Capacitor Background Runner](https://github.com/ionic-team/capacitor-background-runner)
- [BGContinuedProcessingTask 討論（Apple Developer Forums）](https://developer.apple.com/forums/thread/801126)、[How accurate is BGTaskScheduler?](https://developer.apple.com/forums/thread/725675)
- [Shortcuts：個人自動化（Apple 支援）](https://support.apple.com/guide/shortcuts/apd602971e63/ios)、[App Intent 在背景執行（Apple Developer Forums）](https://developer.apple.com/forums/thread/127768)
- [ChatGPT Tasks（Axios）](https://www.axios.com/2025/01/14/chatgpt-tasks-openai-ai-assistant)
