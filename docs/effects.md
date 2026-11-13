# Effect 與計時器

`useEffect`、`useLayoutEffect`、`setTimeout`、`setInterval`、`requestAnimationFrame` 很容易拿來補架構的洞：同一份狀態存兩次、事件已經發生了卻等下一次 render 才處理、不知道在等什麼就先等 300 ms。所以它們只能出現在 `test/code-rules.ts` 的 `EFFECTS` 列出的檔案裡，每個檔案有一個上限：

- 用量超過上限、或不在清單裡的檔案用到，`npm run check` 失敗，錯誤訊息寫出改用什麼。
- 用量比上限少，也失敗，要把上限降下來（棘輪只往下）。
- 真的需要新的 effect（訂閱原生的事件、手勢程式碼裡量過的動畫幀），經使用者同意後把上限加一，並在下表補一列。

## 改用什麼

| 這個 effect 在做什麼 | 改成 |
|---|---|
| 同步外部狀態（runtime、自動化、記憶、瀏覽器、MCP 的訂閱） | `useSubscribed(initial, subscribe, deps)`（`src/app/subscribed.ts`，底下是 `useSyncExternalStore`），或 store 自己有快照時直接 `useSyncExternalStore` |
| 從 state 或 props 推導出另一個值 | render 時算出來（AGENTS.md：一個值只存一次） |
| 對使用者的動作做反應 | 寫在事件處理函式裡 |
| 等一下再做 | 找出它在等的事件（`resume`、`online`、`animationend`、資料寫入的通知），聽那個事件 |
| 真正的 effect | 訂閱原生外掛的事件、`ResizeObserver`、手勢和串流的動畫幀、輪詢遠端（沒有推送可聽） |

## 盤點（2026-11-14）

開始時 `src/` 有 119 個（`useEffect` 74、`useLayoutEffect` 10、`setTimeout` 21、`setInterval` 9、`requestAnimationFrame` 5；`src/app` 79 個），用 AST 數（`test/code-rules.ts` 的 `timingCalls`）。這次拿掉 16 個：

- 15 個同步外部狀態的 `useEffect(() => store.subscribe(setState))` 改成 `useSubscribed`：`App.tsx`（Bot 清單、自動化、瀏覽器、執行中的 Bot）、`Settings.tsx`（自動化 ×2、Bot 清單、全域記憶）、`BotPanel.tsx`（自動化、Bot 的記憶）、`MemoryView.tsx`、`McpGroup.tsx`（`useMcp`）、`BrowserButton.tsx`、`BrowserSheet.tsx`。訂閱來源變成 `undefined`（runtime 重開中）時保留上一個值，跟原本的 `useState` 一樣。
- `Message.tsx` 自己的每秒計時（`useElapsed`）改用 `useNow`（`src/jobs/JobsContext.ts`），同一件事原本有兩種寫法。差別：從過去的時間開始的工作行，一掛上就顯示正確的秒數，不再先空一秒。

剩下 103 個，分類如下。「洞」是還在補洞、留給之後的。

### 外部狀態

| 位置 | 說明 |
|---|---|
| `App.tsx` `controller?.subscribe(setView)` | 對話的 view；`dropConversation`、`openConversation` 也會把它清掉，所以不是單純的訂閱。洞：讓 controller 擁有「沒有對話」的狀態後改 `useSubscribed` |
| `Chat.tsx` `controller.results()`（依 `entries.length` 重讀） | 洞：每多一則就整份重讀；結果應該由 store 推送 |
| `Chat.tsx` `forms.load` | 第一次載入這個 Bot 的表單到 store；之後由 `useSyncExternalStore` 讀 |
| `Composer.tsx` `receiveDraftAdditions` | 訂閱別處加進草稿的附件 |
| `Links.tsx` `reach.onChange` | 只記「恢復的時間」這個事件，不是快照 |
| `HostsGroup.tsx` `watchPrepare` | 訂閱電腦準備中的進度 |
| `Settings.tsx` `Triggers.status` + `resume` | 原生權限狀態，回到前景時重讀 |
| `background.ts` | 同上，背景執行的權限 |

### 推導或重設 state

| 位置 | 說明 |
|---|---|
| `BotSheet.tsx` 換一個 Bot 時重設表單 | 洞：應該用 `key` 換掉整張表單；但抽屜收起的動畫還在顯示舊的欄位，要一起處理 |
| `BotPanel.tsx` 關上時清掉錯誤 | 洞：關上的路徑很多（手勢、返回、點背景），之後讓 `SidePanel` 的關閉事件帶出來 |
| `Links.tsx` 不忙時清掉「恢復時間」 | 洞：同上一類 |
| `Chat.tsx` `sizeWhenLeft` | 離開底部時的高度，存在 ref |
| `Chat.tsx` 有草稿或要求聚焦時 `composerFocus + 1` | 洞：可以變成初始值 |
| `Settings.tsx` `onDraft?.(settings, changed)` | 洞：每次改設定通知上層，應該在 `change` 裡做 |
| `Composer.tsx` 草稿附件存檔 | 寫到 IndexedDB，跟著 state 變 |
| `Chat.tsx` `saveDraftText` | 同上，草稿文字 |

### 等待

| 位置 | 等的是什麼 |
|---|---|
| `App.tsx` `requestAnimationFrame` 收起面板 | 新對話的第一幀畫好才收，收起的動畫不掉幀（在 S24 量過） |
| `App.tsx` 10 秒後 `sweepBotData` | 啟動忙完；洞：沒有「啟動完成」的事件可以聽 |
| `App.tsx` 設定 800 ms 後套用 | debounce：使用者停手 |
| `SignIn.tsx` 回前景 400 ms 後讀剪貼簿 | Android 回前景後剪貼簿要一下子才讀得到 |
| `JobsStrip.tsx` 收起 110 ms | 淡出動畫結束；不用 `animationend`，因為減少動態效果時 `animation: none`，事件不會來，遮罩會擋住整個畫面 |
| `triggers/events.ts` 30 秒後 `releaseIfIdle` | 見那一行的 `why:` |
| `jobs/bash.ts` 輪詢 | 電腦上的指令沒有推送 |
| `promise.ts` `sleep` | 共用的等待 |

### 正當的 effect

| 位置 | 說明 |
|---|---|
| `App.tsx` 啟動時讀設定、找不到 Bot 時關掉對話、打開上次的 Bot、分享和連結的監聽、`Triggers.seen` + `resume`、`globalThis.piRuntime`（裝置腳本用）、執行中的 Bot 結束時通知 | 啟動、原生事件、對外的副作用 |
| `SidePanel.tsx` ×6、`PageStack.tsx` ×2、`sideGesture.ts` | 手勢和頁面的動畫（S24 量過，不動） |
| `streaming.tsx` ×3 | 串流文字每幀追上 |
| `Chat.tsx` 兩個 `useLayoutEffect` | 黏在底部、量輸入框高度（`ResizeObserver`） |
| `Mermaid.tsx`、`Surface.tsx` `useLayoutEffect` | 畫完才量得到寬度、標記選到的段落 |
| `PromptDial.tsx` ×4、`JobsStrip.tsx` 長按 | 長按和連續轉動的計時 |
| `press.ts` | 按下的底色多留一下 |
| `briefly.ts` ×2 | 「已複製」這類結果顯示幾秒 |
| `layers.ts` | 返回鍵的堆疊 |
| `voice.ts`、`BrowserSheet.tsx`（原生事件、觸控、`ResizeObserver`、分頁）、`Surface.tsx`、`PageFrame.tsx` 的 `message` | 訂閱原生或 iframe 的事件 |
| `SidePanel.tsx`、`Composer.tsx` 聚焦 | 打開時把焦點移進去 |
| `Composer.tsx` 掛上時讀回草稿附件、`unmounted` | 載入一次 |
| `loaded.ts`、`ContextCard.tsx`、`HostsGroup.tsx` ×2、`McpGroup.tsx`、`BotPanel.tsx` 工具組、`FileViewer.tsx`、`Surface.tsx`、`ItemSheet.tsx`、`PageFrame.tsx`、`Settings.tsx` 行事曆 | 依 props 讀一次非同步的資料，換 props 時丟掉舊的回覆 |
| `Stage.tsx` ×4、`JobsStrip.tsx` ×2、`JobsContext.ts` ×2 | 輪詢電腦上的工作和瀏覽器畫面、每秒的時鐘 |
| `SignIn.tsx` 卸載時中止 | 清理 |
| `agent/`（`chatgpt.ts`、`phone-env.ts` ×2、`network.ts`、`reach.ts` ×2、`container.ts`、`phone-connection.ts`、`resumable-socket.ts` ×2、`traffic.ts`）、`browser/tool.ts`、`log.ts` | 逾時、重試的退避、心跳、量測視窗、卡頓偵測：時間本身就是規則 |
