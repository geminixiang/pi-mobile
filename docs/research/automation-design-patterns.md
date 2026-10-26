# 自動化的設計：Home Assistant、Tasker、IFTTT、Zapier、Activepieces、Huginn 做對了什麼

研究日期：2026-10-26。接續 [automation-ecosystems.md](automation-ecosystems.md)（那篇問「能不能接它們」，這篇問「能不能學它們」）。來源是各自的官方文件；沒有安裝實測。對照的是 pi-mobile 現在的自動化（[design/triggers.md](../design/triggers.md)、`src/agent/triggers.ts`）。

## 先說結論

這些工具各自用了十年以上，碰過的問題 pi 都會碰到。值得學的有九個，最重要的三個：

1. **狀態與事件分開，狀態結束時自動還原**（Tasker）。「在公司時靜音」是一個狀態：進入時改、離開時**自動改回原本的值**。pi 現在只有事件，要使用者另外建一個「離開公司時恢復」，而且不知道原本是多少。這正好接上「每類東西都能讀也能改」：讀得到原值，就還原得回去。
2. **固定的判斷寫成程式碼，不叫模型**（IFTTT 的 filter code）。IFTTT 讓使用者寫一小段 JavaScript 讀觸發的資料，決定要不要 `skip()` 動作，並留下理由。pi 有 codemode（QuickJS），可以照做：建立自動化時把固定規則寫成腳本。
3. **每次執行的紀錄**（Home Assistant 的 trace）。觸發來源、條件有沒有過、每一步做了什麼、停在哪裡，每個自動化留最近 5 次，「沒觸發」另外存。pi 每個自動化只記最後一次。

## 對照表

| # | 設計 | 誰 | 它怎麼做 | pi 現在 | 建議 |
|---|---|---|---|---|---|
| 1 | **狀態 vs 事件；離開狀態時還原** | Tasker | State context 在條件成立期間有效，結束時跑 Exit task；Enter task 直接改的設定，profile 結束時**自動還原**成原本的值。Event context 沒有結束，改了就不還原 [T1] | 只有事件；Wi‑Fi、地點有「連上／離開」兩個事件，但互不相關 | **A**：自動化可以是「期間」：到達 X／連上 X 期間做某事，離開時把改過的狀態還原。工具改狀態時回報改前的值（`sound`、`display`、`connections` 已經在讀），runtime 記下來，離開時寫回 |
| 2 | **固定規則寫成程式，可以 skip 並留理由** | IFTTT | filter code：JavaScript 讀 `Trigger.<欄位>`，呼叫 `<動作>.skip("理由")`，理由顯示在 Applet 的活動紀錄 [I1] | Do 一律叫模型；`only_if` 用 classifier 判斷；略過時那一列寫理由 | **A**：Do 可以是 codemode 腳本（見 automation-ecosystems.md A1）。腳本可以 `skip(理由)`，理由進紀錄（#3） |
| 3 | **執行紀錄（trace）** | Home Assistant | 每次執行：哪個觸發、條件結果、每一步、停在哪；預設每個自動化留 5 次，「沒觸發」另存；可下載 JSON，提醒分享前遮掉個資 [H3] | `last`：只有最後一次的時間、送達方式、錯誤或略過理由 | **A**：每個自動化留最近 N 次（例如 10），每次記：事件內容摘要、If 結果（原生條件、guards、only_if 的機率）、跑了 agent 還是腳本、結果。自動化那一列點開看得到 |
| 4 | **再次觸發時的模式** | Home Assistant | `single`（預設，忽略新的）、`restart`（中止目前的重來）、`queued`（排隊，條件在**入列時**判斷）、`parallel`；`max` 預設 10 [H1] | 原生端「最多多久一次」加每天上限；同一事件用 `requestId` 去重 | **B**：通知類（「媽媽的每則 LINE」）需要 `queued`；目前的間隔等於 `single` 加冷卻。先把現有行為寫成明確的模式名稱，再決定要不要加 `queued` |
| 5 | **持續多久才算（`for`）** | Home Assistant | 觸發：狀態變成 X **並維持** 5 分鐘才觸發；條件：已經是 X 至少 10 分鐘。重開機時計時歸零 [H2] | 沒有；Wi‑Fi 一閃斷又連上就會再觸發 | **B**：Wi‑Fi、藍牙、地點加 `for`（在原生端用延遲的 `PendingIntent` 確認狀態仍成立）。減少誤觸發，也減少叫醒模型 |
| 6 | **一個自動化多個觸發，依觸發分支** | Home Assistant | 每個觸發有 `id`；動作用 `choose` 配「由哪個觸發」條件走不同分支 [H4] | 一個排程一個 When；`triggers.md` 已計畫多個 When | **B**：做多個 When 時每個帶 id，觸發的訊息或腳本拿得到是哪一個。和 #1 合起來：「連上／離開」是同一個自動化的兩端 |
| 7 | **匯總（digest）** | Zapier | 收集多筆，按時間、數量門檻或另一個流程一次放出 [Z1] | 每個事件各自叫醒模型，受每天 10 次上限 | **B**：通知類自動化可以選「每 N 小時或滿 M 則，一次處理」。一次 agent run 處理一批，正好解 `triggers.md` 待決定第 7 題 |
| 8 | **事件 id 去重** | IFTTT、Activepieces | IFTTT：每個事件有穩定的 `meta.id`，只對沒看過的觸發 [I2]；Activepieces 輪詢用時間或最後一筆 id 去重，webhook 要自己做冪等 [A1] | 有：事件 id 當 `requestId`，pi-durable 去重 | **C**：做外部事件入口（webhook）時沿用：要求來源帶事件 id，沒有就用內容雜湊 |
| 9 | **可分享的範本（blueprint）** | Home Assistant | 自動化寫成範本，宣告輸入（名稱、說明、selector、預設值），別人套用時只填輸入 [H5] | 自動化由 agent 用自然語言建立 | **C**：先不做。agent 本身就是「自然語言 → 自動化」；等有使用者想分享再看 |

另外兩個看過、決定不學的：

- **乾跑（dry run）**（Huginn）：只顯示會產生什麼，不保存 [G1]。pi 已有「手動執行」，而 Home Assistant 也提醒「手動執行會跳過觸發和條件，成功不代表真的觸發會成功」[H3]。比較好的是 #3 的紀錄：看真實的那一次。
- **延遲與等待觸發**（Zapier Delay [Z1]、Home Assistant `wait_for_trigger` 加逾時 [H6]）：pi 的 agent 可以 `schedule_followup`，已經涵蓋「稍後再看」。

## 建議的做法與順序

1. **#3 執行紀錄**：最小、最先做。之後 #1、#2、#4 的行為都要靠它才看得出對不對。
2. **#2 腳本 Do**：固定規則不叫模型（同 automation-ecosystems.md A1），腳本的 `skip(理由)` 寫進 #3。
3. **#1 期間與還原**：在 #2 之上。「期間」自動化的進入端跑腳本或 agent；工具回報的改前值記在這次期間裡；離開端自動寫回，再跑使用者指定的離開動作（如果有）。還原的規則照 Tasker：使用者在離開動作裡自己改了同一個設定，就不自動還原那一項 [T1]。
4. **#5 持續多久、#6 多個 When、#7 匯總**：各自獨立，依使用者遇到的問題決定先後。

驗證方式（S24 可用時）：

- #1：「在家時鈴聲開 30%，離開家恢復」：進入後鈴聲 30%，離開後回到原本的震動。
- #2：「連上 Zhao 開鈴聲」：觸發 10 次，0 次模型呼叫；斷網時一樣成功。
- #3：Wi‑Fi 斷連 3 次，紀錄裡看得到 3 次觸發、各自的 If 結果。

## 來源

- [T1] Tasker：State 與 Event context、Exit task、Restore Settings。https://tasker.joaoapps.com/userguide/en/activity_stateedit.html ；https://tasker.joaoapps.com/userguide/en/activity_main.html ；https://tasker.joaoapps.com/userguide/en/faqs/faq-how.html
- [I1] IFTTT Applets（filter code、`skip()`）。https://ifttt.com/docs/applets ；cheat sheet：https://ifttt.com/explore/filter-code-cheat-sheet
- [I2] IFTTT API reference（`trigger_identity`、`meta.id` 去重、Realtime API）。https://ifttt.com/docs/api_reference
- [H1] Home Assistant：Automation modes。https://www.home-assistant.io/docs/automation/modes
- [H2] Home Assistant：State trigger、State condition、Durations。https://www.home-assistant.io/triggers/state/ ；https://www.home-assistant.io/conditions/state/ ；https://www.home-assistant.io/docs/automation/durations/
- [H3] Home Assistant：Testing automations（traces）、Troubleshooting。https://www.home-assistant.io/docs/automation/testing ；https://www.home-assistant.io/docs/automation/troubleshooting/
- [H4] Home Assistant：Trigger id、Choose。https://www.home-assistant.io/docs/automation/trigger/ ；https://www.home-assistant.io/building-blocks/choose/
- [H5] Home Assistant：Blueprint schema、Selectors。https://www.home-assistant.io/docs/blueprint/schema/ ；https://www.home-assistant.io/docs/blueprint/selectors
- [H6] Home Assistant：Scripts（`wait_for_trigger`、`continue_on_timeout`）。https://www.home-assistant.io/docs/scripts/
- [Z1] Zapier：Filters、Paths、Delay、Digest。https://help.zapier.com/hc/en-us/articles/8496276332557 ；https://help.zapier.com/hc/en-us/articles/8496288555917 ；https://help.zapier.com/hc/en-us/articles/8496288754829 ；https://help.zapier.com/hc/en-us/articles/8496309901453
- [A1] Activepieces：Polling 與 webhook trigger。https://www.activepieces.com/docs/build-pieces/piece-reference/triggers/polling-trigger
- [G1] Huginn：Creating a new Agent（dry run、keep events）。https://github.com/huginn/huginn/wiki/Creating-a-new-Agent
