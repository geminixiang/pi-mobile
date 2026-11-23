# Effect 與計時器

四條規則，`npm run check`（`test/code-rules.ts` 的 `effectRule` 和 `lifecycleRule`，用 AST 找）強制，沒有例外名單；`src/` 和 `packages/` 裡的 package 都一樣：

1. `src/` 裡沒有 effect hook：`useEffect`、`useLayoutEffect`、`useInsertionEffect`。
2. 計時器只在 `pi-mobile-base/time`（`packages/pi-mobile-base/src/time.ts`）裡呼叫：`setTimeout`、`setInterval`、`requestAnimationFrame`、`requestIdleCallback`、`postTask`、`AbortSignal.timeout`。其他地方用它的 helper，每個都回傳取消的方法（`Cancel`）。
3. ref callback 只跟著它那個元素的一生：`useCallback(…, [])`。每次 render 新建的、或帶 deps 的 ref callback 會在 props 變的時候重跑，就是換個寫法的 effect（只把元素存進 ref 的不算）。
4. `useSyncExternalStore` 的快照要是來源真的有的值。回傳常數的快照只是借用 subscribe 當生命週期。

檢查抓不到、但一樣不行的：store 的 subscribe 裡做跟它的值無關的一次性工作；把整個元件的生命週期掛在隨便一個 div 的 ref 上（掛在那件事本身的元素上：編輯中的 textarea、等著貼上的輸入框）。

原因（[research/all-code-is-slop.md](research/all-code-is-slop.md)）：effect 和計時器是 agent 和人最常寫出 bug 的地方。計時器在擁有者結束後還在跑、callback 拿到舊的 state、用延遲蓋住競態、用 effect 補架構的洞（同一份狀態存兩次、事件已經發生卻等下一次 render 才處理）。

## 改用什麼

| 要做的事 | 改成 |
|---|---|
| 讀外部的狀態（store、runtime、原生外掛或 Capacitor 的事件） | `useSubscribed(initial, subscribe, deps)`（`pi-mobile-ui/store`）；store 自己有快照時直接 `useSyncExternalStore`。來源換掉時保留上一個值 |
| 外部的狀態，自己也會寫（讀進來之後由按鈕改） | `useStore(initial, subscribe, deps)`，回傳 `[value, set]`；`set` 接受值或 `(current) => next`，回傳寫入後的值 |
| 讀一次非同步的資料 | `useLoaded(load, deps)`（`pi-mobile-ui/store`）：換 deps 時回到讀取中，帶錯誤訊息。要保留上一個值時用 `useSubscribed(initial, promised(load), deps)` |
| 輪詢 | `usePolled(read, everyMs, deps)`；`read` 回 `undefined` 表示這次沒讀到，保留上一個值 |
| 回到前景時重讀原生的狀態 | `useSubscribed(initial, resumed(read), deps)`（`pi-mobile-ui/platform`）；只聽回到前景用 `onResume(run)` |
| 隨時間變的值（時鐘、顯示兩秒、淡出之後） | 一個 store，它的 subscribe 啟動 `every`、`after` 或 `eachFrame` 並回傳取消：`useNow`、`useBriefly`、`useExpired`（`pi-mobile-ui/store`）、`useSmoothText` |
| 跟著一個 DOM 元素的事（量尺寸、出現時聚焦、`ResizeObserver`、`MutationObserver`、聽 `window` 的事件、離開時存檔或中止） | `useCallback(…, [])` 的 ref callback，回傳 cleanup；要用到的 props 從 render 時寫入的 ref 讀（`latest.current`） |
| prop 變了要做事（面板開關的動畫和焦點、瀏覽器面板開關時的原生呼叫） | 不要等 render：讓狀態的擁有者可以訂閱（`Source<T>`：`{ subscribe, read }`，`pi-mobile-ui/store`），做事的物件在自己元素的 ref callback 裡訂閱它，在 listener 裡反應。`SidePanel` 的 `place`、`PageStack` 的 `opened`、`BrowserSheet` 的 `screen` 都是這樣；元件自己的狀態要給別人跟時用 `useStore` 回傳的第三個值，或 `cell(initial)` |
| 一個狀態轉換要帶副作用（瀏覽器面板開了要截圖、關了要收起原生畫面） | 在做轉換的那個函式裡做：`step(event)` 算出前後兩個狀態，再照差異反應（`BrowserSheet.tsx`） |
| 元素換了內容要重做（換一張圖、換一段 Mermaid） | 給元素 `key`，讓它的出現就是觸發（`Mermaid`、`FileViewer` 的圖片） |
| 交給剛要掛上的元件的東西（分享進來的檔案） | 信箱：送的人先放著（`offerFiles`），元件訂閱時領走（`receiveDrafts`，`src/app/chat/drafts.ts`） |
| 硬體返回鍵 | 開著的那一層在自己的元素上寫 `data-back` 和 `onKeyDown`（`isBack(event)`，`pi-mobile-ui/platform`）；返回鍵把一個鍵盤事件送給文件順序最後一個 `[data-back]`，也就是最上面、最裡面的那一層（`backToTop`），沒有任何一層開著時由 `UiPlatform` 把 App 收到背景 |
| 對使用者的動作做反應（存草稿、通知上層、開始長按） | 寫在造成改變的事件處理函式裡 |
| id 換了要重設 state | 給元件一個 `key`，或在 render 時比對後 `setState`（`BotSheet`、`Links.tsx` 的 `useBack`） |
| 從 state 或 props 推導出來的值 | render 時算（AGENTS.md：一個值只存一次） |
| App 一啟動、runtime 一開、對話一打開就要做的事 | 不屬於任何元件：寫在 `src/app/session.ts`（`boot`、`start`、`open`），`main.tsx` 呼叫 `boot()` |
| 等一下再做 | 先找它在等的事件（`resume`、`online`、`pointerup`、資料寫入的通知）並聽那個事件；真的只有時間時用 `after`，由結束它的事件取消 |

## `pi-mobile-base/time` 的 helper

| helper | 用途 |
|---|---|
| `sleep(ms)` | 等一段時間的 Promise |
| `after(ms, run)` | 一段時間後做一次 |
| `every(ms, run)` | 每隔一段時間做一次 |
| `deadline(ms)` | 逾時就中止的 `AbortSignal` |
| `nextFrame(run)` | 下一個動畫幀做一次 |
| `eachFrame(run)` | 每個動畫幀做一次，直到取消（手勢的收合、串流文字） |
| `afterPaint(run)` | 目前這一幀畫完之後（兩個動畫幀） |

## 量過、要知道的地方

- 對話的 view 由 `src/app/session.ts` 訂閱、`App.tsx` 用 `useSyncExternalStore` 讀，每次變更同步 render 一次。在桌機 Chrome 用 `test/perf/server.ts` 量過：串流時 view 每 150 ms 的一批才變一次（10 秒 66 到 67 次），pi-durable 的 watch 已經把同一批的變更併起來，React 的 commit 數和原本用 `setState` 時一樣。
- 對話黏在底部用 `MutationObserver`（`Chat.tsx` 的 `follow`），不是 `ResizeObserver`。原因有兩個，都量過：`ResizeObserver` 要多包一層內容的 div，舊訊息的 `content-visibility` 佔位高度就從 0 變成 320 px（現在是被 `.transcript` 的 flex 壓成 0），捲動位置和往上捲時一次展開幾則都變了；而且它在排版之後才通知，那時最上面的佔位已經被當成在畫面上、展開過一次，接著一路展開到底。`MutationObserver` 在 commit 之後、排版之前通知，跟原本每次 render 後捲到底的時機一樣。串流中的那一則另外用 `ResizeObserver` 跟（圖片、圖表載入後變高）。
- `src/app/chat/streaming.tsx` 的串流文字在 rAF 裡同步 render（SyncLane），等 S24 量過再決定要不要改。
