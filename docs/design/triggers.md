# 觸發：讓 agent 在你開口之前就動起來

狀態：第 1 階段已實作（時間、agent 自己排的下一步、分享給 pi；程序不在時用 B）。其餘待決定。

## 目標

現在只有一種方式能啟動 agent run：使用者送出訊息（打字、語音、首頁範例、插話或排隊）。app 被殺掉後重開時，`harness.resume()` 會接著跑完中斷的 run，但那是延續，不是新的觸發。

這份文件規劃其他觸發來源，例如時間、手機事件、位置、別的 app、外部系統。這些來源各不相同，但要解決的是同一組問題：

- 程序不在時怎麼跑
- run 落在哪個對話
- 沒人看著時誰核准寫入
- 結果怎麼告訴你
- 成本怎麼控制

所以要一起設計，不要一個一個各自做。

## 觸發來源

| 來源 | 例子 | Android 機制 | 權限 | 程序不在時 |
|---|---|---|---|---|
| 時間（單次、重複） | 早晨簡報、每週五整理、「30 分鐘後提醒我」 | `AlarmManager.setExactAndAllowWhileIdle` | 精確鬧鐘（Android 14 起預設不給，要引導開啟） | 鬧鐘會把程序叫起來，但 WebView 不在 |
| agent 自己排的下一步 | 「部署跑完了嗎？10 分鐘後再看」 | 同上 | 同上 | 同上 |
| 手機事件 | 開始充電、連上某個 Wi-Fi、戴上耳機、開機 | 動態註冊的 `BroadcastReceiver`、`ConnectivityManager.NetworkCallback`；開機用 `BOOT_COMPLETED` | 不需要 | 多數廣播只送給執行中的程序，所以要靠前景服務常駐，或改用 WorkManager 的條件 |
| 位置 | 到家、離開公司 | Geofence（`play-services-location` 或 `LocationManager.addProximityAlert`） | **背景定位**（「一律允許」） | 系統會把程序叫起來 |
| 分享給 pi | 從瀏覽器、相簿「分享到 pi」 | `ACTION_SEND` intent filter | 不需要 | 不受影響：分享本來就會打開 app |
| 別的 app 的通知 | 某人傳 LINE、銀行入帳 | `NotificationListenerService` | 通知存取權 | 系統綁定這個服務，所以程序會在 |
| 外部事件 | GitHub PR 有新留言、sandbox 的長任務跑完 | 手機連著 relay 時走現有的 WebSocket；不在時要推播：FCM，或 UnifiedPush（例如 ntfy） | FCM 要 Firebase 專案 | 高優先 FCM 可以叫起程序並啟動前景服務 |

## 問題一：程序不在時怎麼跑

agent 跑在 WebView 裡（pi-durable、pi-ai、所有工具都是 JavaScript）。觸發時如果 Android 已經清掉 pi 的程序，被叫起來的只有原生的部分，**沒有 WebView，也就沒有 agent**。

Android 的限制：

- **從背景啟動前景服務**：只在精確鬧鐘觸發、或高優先 FCM 送達的那一刻例外允許，而且要立刻啟動。([背景啟動前景服務的限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start))
- **從背景打開 Activity**：Android 10 起禁止。使用者授予「顯示在其他應用程式上層」（`SYSTEM_ALERT_WINDOW`）是官方列出的例外，Android 15 仍然有效。([背景啟動 Activity 的限制](https://developer.android.com/guide/components/activities/background-starts))
- **我們的前景服務類型是 `specialUse`**：不受 Android 15 對 `dataSync` 的「每天 6 小時」限制。([前景服務逾時](https://developer.android.com/develop/background-work/services/fgs/timeout))

做法：

| | 做法 | 優點 | 缺點 |
|---|---|---|---|
| A | **程序還在**：原生端直接把事件交給 JS | 簡單、立即 | 只在 pi 最近用過時有效 |
| B | **點一下才跑**：程序不在時發通知「早晨簡報：點一下產生」 | 不需要特殊權限 | 不是真的主動，要等 20–30 秒 |
| C | **安靜重啟**：有 `SYSTEM_ALERT_WINDOW` 時，由觸發從背景啟動 `MainActivity`。預期螢幕關著時在鎖屏後面啟動、不點亮螢幕；螢幕亮著時立刻退到背景（都需要實測） | 真正在背景跑完 | 要一個大權限；螢幕亮著時可能閃一下；需要實測 |
| D | **無頭 WebView**：前景服務自己建一個 WebView 來跑 agent | 最乾淨 | Capacitor 的 bridge 綁在 Activity 上，等於要自己重寫一套 plugin bridge。不建議 |

**建議**：A，加上 C（使用者自己選擇開啟），沒開 C 時退回 B。三者共用同一條路徑（見下面的「事件佇列」），差別只在「JS 什麼時候開始處理佇列」。

**先量測**（第 0 階段）：在 S24 上記錄一週 pi 程序被清掉的時間點，例如用原生端的鬧鐘每 15 分鐘記一次「程序還在嗎、WebView 還在嗎」。這可以知道 A 的實際涵蓋率，以及 C 值不值得做。

## 統一模型

```
觸發來源 ──▶ 原生接收器 ──▶ 事件佇列（原生端持久化）──▶ JS 取出 ──▶ 對話送出輸入 ──▶ run ──▶ 通知
             （鬧鐘、廣播、       （檔案或 SharedPreferences，     （啟動時、事件來時、     （entry 類型
              geofence、分享…）    程序不在也記得住）               安靜重啟後）            trigger.*）
```

- **事件佇列放在原生端**：觸發當下不管 JS 在不在都先記下來，JS 起來後再處理。A、B、C 只差在「JS 起來的時機」，邏輯只寫一份。事件要帶 id，處理過就刪除，重複送達不會跑兩次。
  - 事件的 id 變成送出輸入時的 `requestId`（`trigger:<id>`），pi-durable 用它去重，所以同一個事件再送一次只會有一則輸入。執行紀錄也帶著它，留到隔天結束：處理事件時先看它是不是已經記過，記過的只再同步一次，不再計次、不碰上限、不動 Bot 的時間和完成通知。
  - 輸入送出之後才記執行次數、刪掉一次性排程，最後才向原生端確認（ack）。中間任何一步失敗，事件留在佇列，下次 app 回到前景或有新事件時重試，排程列表顯示「沒有送出，會再試」；超過一天還失敗才丟掉，排程列表寫明這次跳過。
  - 一次性排程一被原生端觸發就標成 `fired`，同步時不再交給原生端：原生端對過了時間的一次性排程會在 5 秒後補觸發，沒有這個標記，送出失敗時每次同步都會多觸發一次。
  - 排程暫停之後，佇列裡還沒處理的事件不會再執行（手動執行不受影響）。
- **觸發的輸入用自訂 entry**：pi-durable 的 `submit({ type: "input", content, entry: { kind: "trigger.alarm", data } })` 可以把觸發的訊息顯示成「⏰ 排程：早晨簡報」，模型看到的仍是 `content`。([pi-durable README，Custom inputs](../../node_modules/@earendil-works/pi-durable/README.md))
- **觸發器的定義**：

  ```ts
  type Trigger = {
    id: string;
    name: string;                      // 「早晨簡報」
    when:                              // 來源和條件
      | { kind: "time"; at: string; repeat?: "daily" | "weekdays" | { days: Weekday[] } }
      | { kind: "once"; at: number }
      | { kind: "charging" | "wifi" | "headphones"; ... }
      | { kind: "place"; latitude: number; longitude: number; radius: number; on: "enter" | "exit" }
      | { kind: "share" }
      | { kind: "notification"; app: string; match?: string }
      | { kind: "external"; source: string };
    prompt: string;                    // 交給 agent 的指示
    conversation: "new" | "thread" | { id: ConversationId };   // 見問題二
    enabled: boolean;
    limits: { perDay: number };
    model?: string;                    // 可指定較便宜的模型
  };
  ```

- **存在 pi-durable 的 app 層級文件**（像 `ConversationIndex`）：agent 的工具可以在交易裡建立和修改，UI 可以訂閱變化。原生端需要一份副本來註冊鬧鐘和 geofence，並在開機後重新註冊，所以由 JS 在每次變更後同步過去。

## 問題二：run 落在哪個對話

| 選項 | 適合 |
|---|---|
| 每次開新對話 | 互不相關的事件，例如每則分享 |
| 每個觸發器一個固定對話（thread） | 早晨簡報、每週整理。agent 看得到前幾天的結果，可以說「比昨天多了一個會」 |
| 回到原本的對話 | agent 自己排的下一步。「10 分鐘後再看部署」的結果應該接在原本那段討論後面 |

**建議**：預設每個觸發器一個 thread；agent 自己排的回到原對話；分享每次開新的。thread 太長時，用現有的壓縮機制處理。

**後來的決定（改成 Bot）**：每個 Bot 只有一條對話，排程和 agent 自己排的下一步都在建立它的 Bot 的對話裡跑，分享則交給你選的 Bot。不再有「每次開新對話」。對話靠自動壓縮控制長度。

## 問題三：沒人看著時的寫入

背景 run 可能碰到要核准的寫入，例如 `git push`、新增行事曆活動、雲端資源變更。現在的確認框只有 app 在前景時看得到，app 不在前景時會發一則「pi 需要你確認」的通知。

**後來的決定（2026-10-23）**：拿掉了所有核准，背景 run 的寫入直接執行，下面的通知核准和「只讀」觸發器都不做了。

**原本的建議**：
- 確認通知直接帶「允許」「拒絕」兩個按鈕，不必打開 app。
- **30 分鐘沒回應就當作拒絕**，run 繼續，並在結果裡說明。
- 觸發器可以設成「只讀」：該次 run 的寫入一律自動拒絕，不打擾你。早晨簡報這類觸發器預設只讀。

## 問題四：結果怎麼告訴你

- 給 agent 一個 `notify` 工具（標題、內文、點了打開哪裡），**由 agent 判斷值不值得通知**。例如「沒有新留言」就安靜結束，不必每次都發。
- 觸發的通知用獨立的通知頻道「pi 主動通知」，跟「工作中」「需要確認」分開，讓你可以在系統設定裡單獨調整。
- 點通知會打開那個 run 所在的對話。

## 問題五：管理與成本

- **設定頁的「觸發」區塊**：列出所有觸發器，顯示下次執行時間、最近一次結果；可以暫停、刪除、立即執行。
- **agent 工具**：`create_trigger`、`list_triggers`、`update_trigger`、`delete_trigger`。建立和修改都要你核准，確認框寫明「什麼時候、做什麼」。這樣「每天早上 8 點給我簡報」這句話就能直接設定好。
- **上限**：每個觸發器每天最多跑幾次（預設 10 次），全部加起來每天也有上限（預設 30 次），避免觸發器失控一直耗用 token。超過時通知你一次，當天暫停該觸發器。
- **模型**：觸發器可以指定比較便宜的模型。

## 分階段

| 階段 | 內容 |
|---|---|
| 0 | 量測 S24 上 pi 程序和 WebView 的存活情況 |
| 1 | 共用的基礎：原生事件佇列、觸發器文件與同步、`trigger.*` entry 在 UI 的樣子、`notify` 工具、通知上的核准按鈕。來源先做**時間**、**agent 自己排的下一步**、**分享給 pi**。程序不在時用 B |
| 2 | 依第 0 階段的結果決定要不要做 C（安靜重啟）。加上手機事件（充電、Wi-Fi、耳機）和位置（geofence 加背景定位） |
| 3 | 別的 app 的通知（NotificationListener）、外部事件（relay 推送，必要時加 FCM 或 UnifiedPush） |

### 第 2 階段的第一個來源：戴上耳機

- **藍牙**：`BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED` 是 Android 8 之後少數 manifest receiver 還收得到的廣播，所以 pi 不在執行也能觸發（`HeadphonesReceiver`，要 exported，因為廣播來自藍牙的程序；這個 action 只有系統能送）。Android 12 起要 `BLUETOOTH_CONNECT`。用 `BluetoothClass` 排除車用音響、喇叭。
- **有線**：`ACTION_HEADSET_PLUG` 只送給執行中 app 動態註冊的 receiver，所以只在 pi 執行中時有用。
- **條件**：星期幾、時段（可跨午夜）、最多每幾小時一次；24 小時代表「每天第一次」。間隔在原生端算，因為耳機常常一次連兩下，第二下不能在第一個 run 還在等 WebView 時又排一次。
- **送達**：跟鬧鐘同一條路（`TriggerReceiver.fire`）：WebView 在就直接跑（凍結中的程序也會被廣播叫醒），不在就跳「點一下開始」。
- **輸出**：`speak` 工具（Android `TextToSpeech`，`USAGE_ASSISTANT`，暫時壓低其他聲音）。觸發的訊息寫明「headphones connected」，系統提示要 agent 用 speak 口語匯報。耳機斷線時停止朗讀。

## 下一步：When → If → Do → Tell

2026-10-24 定下的方向：先專心增加「什麼能觸發 agent run」，Do 一律是 agent run。觸發之後不跑 agent、改跑固定動作或腳本，是之後另一層的事，不在這裡。

| 段 | 是什麼 | 現在 | 要做的 |
|---|---|---|---|
| **When** | 什麼事發生 | 一個排程只有一個來源：時間、耳機、充電、Wi‑Fi、到達或離開 | 加來源（下表）；一個排程可以有多個 When，任一個發生就算 |
| **If** | 發生時要不要理 | `EventWindow`：星期幾、時段、最多多久一次，在原生端（`TriggerStore.java`）判斷 | 在原生端多加幾種固定的條件，不符合就不叫醒 WebView、不算次數 |
| **Do** | agent run | 排程的 prompt 送進 Bot 的對話 | 不變；觸發的訊息帶上事件的內容（例如通知的寄件人和文字），agent 不必再去查 |
| **Tell** | 結果怎麼讓你知道 | agent 自己決定 `notify`、`speak` 或什麼都不說 | 不變 |

`EventWindow` 已經是 If 的第一個形態，所以這是把現有的排程放寬，不是另做一套。`create_schedule` 照舊是 agent 建立它的方式。

### 新的 When

| 優先 | 來源 | Android 機制 | pi 不在時 | 備註 |
|---|---|---|---|---|
| 1 | 別的 app 的通知（**已做**） | `NotificationsListener` 寫進 `NotificationStore` 時，只有新的一則才交給 `TriggerReceiver.notification` | 收得到：系統綁著這個服務 | If 是 app（名稱或套件）和「含某段文字」，加上原本的時段和間隔。app、寄件人和前 500 字放進觸發的訊息。間隔最少 1 小時，所以還不能「每則都處理」。通知內容還沒標成不受信任的輸入（先讓流程跑通，待決定第 6 題） |
| 1 | NFC 貼紙 | NDEF intent filter，貼紙寫入 pi 自訂的 URI | 收得到：intent 會打開 pi | 一碰就跑，像一顆實體按鈕；pi 要能幫你把貼紙寫好 |
| 2 | 指定的藍牙裝置 | 跟耳機同一個 A2DP 廣播，加上 HFP 的 | 收得到 | 以裝置位址指定；車用音響現在被刻意排除，指定了就算 |
| 2 | 快速設定磁貼、桌面捷徑 | `TileService`、`ShortcutManager` | 收得到：使用者按的 | 手動跑某個排程 |
| 2 | 外部 webhook | ntfy（UnifiedPush）或 FCM | 收得到 | 待決定第 3 題 |
| 2 | 開始走路、上車、靜止 | Activity Recognition Transition API（`play-services-location`），`PendingIntent` | 收得到 | 在晶片裡判斷，幾乎不耗電；要 `ACTIVITY_RECOGNITION` 權限 |
| 2 | 螢幕亮、解鎖 | `SCREEN_ON`、`USER_PRESENT`，只送給執行中程序的動態廣播 | 有通知讀取時收得到：系統綁著服務，程序一直在 | 不另開前景服務 |
| 2 | 拍了新照片、聯絡人或行事曆變了 | JobScheduler 的 `addTriggerContentUri` | 收得到 | 系統在內容變動時排一個 job，可以設定延遲合併 |

### 新的 If

全部在原生端判斷，條件是固定的幾種，不是任意的運算式：

- 已有：星期幾、時段、最多多久一次。
- 在不在某個地點（用最近一次的位置，不另外定位）。
- 電量高於或低於、是否在充電。
- 勿擾是否開著、耳機是否連著。
- 通知：哪個 app、寄件人、標題或內文包含某段文字。

被 If 擋下的不算進每天的上限，因為沒有叫醒模型。

### 省電：只用系統已有的事件機制

2026-10-24 的決定：觸發來源只用「系統或硬體盯著、有事才叫醒 pi」的機制：系統廣播、`PendingIntent`（鬧鐘、Geofence、JobScheduler、Activity Recognition）、系統綁著的服務（通知讀取）、觸發一次就停的感測器。pi 不自己輪詢，也不為了觸發另開常駐的前景服務。

耗電由低到高：低功耗晶片自己判斷 → 系統叫醒 Java 端判斷 If 就睡回去 → 程序一直收感測器資料 → 叫醒 WebView 跑模型。前兩層可以用，第三層不做，第四層靠 If 擋。

所以不做的：

- **用感測器當觸發**（扭手腕、甩手機、翻面、`significant_motion`、步數）：Android 9 起在背景的 app 收不到任何感測器的事件，持續回報、有變化才回報、觸發一次就停的都一樣，要常駐前景服務才行。觸發後的 run 有 `AgentService` 這個前景服務，所以 `read_sensors` 在那時讀得到。
- **Samsung 和 Android 的系統手勢感測器**（`pick_up_gesture`、`tilt_detector`、`wake_up_motion`、`Pocket mode`、`Drop Classifier`、`Car Crash Detect`）：是系統隱藏或廠商私有的，第三方 app 拿不到；`dumpsys sensorservice` 列得出來不代表可以用。

## 待決定

1. 程序不在時：接受 B，還是要做 C（需要「顯示在其他應用程式上層」權限）？
2. 背景 run 碰到寫入：「通知上核准，30 分鐘逾時就拒絕」可以嗎？
3. 外部事件要不要用 FCM？FCM 需要 Firebase 專案和 `google-services.json`，對開源專案來說每個使用者都要自己設定一個。UnifiedPush 不需要 Google，但手機要另外裝一個推播 app（例如 ntfy）。
4. 第一階段的觸發來源：時間、agent 自己排的下一步、分享給 pi，這三個可以嗎？
5. 一個排程有多個 When 時，「最多多久一次」是整個排程共用，還是每個 When 各算？
6. 通知觸發時，事件的內容（寄件人、文字）直接放進觸發的訊息，模型就看得到通知裡的東西，等於別人可以把文字送進 agent。要不要像 email 一樣標成不受信任的輸入？2026-10-24：先做骨幹、讓流程跑通，防禦之後補。
7. 通知的間隔要不要允許小於 1 小時（例如「媽媽的每則 LINE」）？那會碰到每天 10 次的上限。
