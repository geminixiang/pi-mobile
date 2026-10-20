# 觸發：讓 agent 在你開口之前就動起來

狀態：第 1 階段已實作（時間、agent 自己排的下一步、分享給 pi；程序不在時用 B；通知上核准）。其餘待決定。

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

## 問題三：沒人看著時的寫入

背景 run 可能碰到要核准的寫入，例如 `git push`、新增行事曆活動、雲端資源變更。現在的確認框只有 app 在前景時看得到，app 不在前景時會發一則「pi 需要你確認」的通知。

**建議**：
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

## 待決定

1. 程序不在時：接受 B，還是要做 C（需要「顯示在其他應用程式上層」權限）？
2. 背景 run 碰到寫入：「通知上核准，30 分鐘逾時就拒絕」可以嗎？
3. 外部事件要不要用 FCM？FCM 需要 Firebase 專案和 `google-services.json`，對開源專案來說每個使用者都要自己設定一個。UnifiedPush 不需要 Google，但手機要另外裝一個推播 app（例如 ntfy）。
4. 第一階段的觸發來源：時間、agent 自己排的下一步、分享給 pi，這三個可以嗎？
