# Effect 與計時器

兩條規則，`npm run check`（`test/code-rules.ts` 的 `effectRule`，用 AST 數）強制，沒有例外名單：

1. `src/` 裡沒有 effect hook：`useEffect`、`useLayoutEffect`、`useInsertionEffect`。
2. 計時器只在 `src/time.ts` 裡呼叫：`setTimeout`、`setInterval`、`requestAnimationFrame`、`requestIdleCallback`、`postTask`、`AbortSignal.timeout`。其他地方用它的 helper，每個都回傳取消的方法（`Cancel`）。

原因（[research/all-code-is-slop.md](research/all-code-is-slop.md)）：effect 和計時器是 agent 和人最常寫出 bug 的地方。計時器在擁有者結束後還在跑、callback 拿到舊的 state、用延遲蓋住競態、用 effect 補架構的洞（同一份狀態存兩次、事件已經發生卻等下一次 render 才處理）。

## 改用什麼

| 要做的事 | 改成 |
|---|---|
| 讀外部的狀態（store、runtime、原生外掛或 Capacitor 的事件） | `useSubscribed(initial, subscribe, deps)`（`src/ui/subscribed.ts`）；store 自己有快照時直接 `useSyncExternalStore`。來源換掉時保留上一個值 |
| 外部的狀態，自己也會寫（讀進來之後由按鈕改） | `useStore(initial, subscribe, deps)`，回傳 `[value, set]`；`set` 接受值或 `(current) => next`，回傳寫入後的值 |
| 讀一次非同步的資料 | `useLoaded(load, deps)`（`src/ui/loaded.ts`）：換 deps 時回到讀取中，帶錯誤訊息。要保留上一個值時用 `useSubscribed(initial, promised(load), deps)` |
| 輪詢 | `usePolled(read, everyMs, deps)`；`read` 回 `undefined` 表示這次沒讀到，保留上一個值 |
| 回到前景時重讀原生的狀態 | `useSubscribed(initial, resumed(read), deps)`（`src/ui/resume.ts`）；只聽回到前景用 `onResume(run)` |
| 隨時間變的值（時鐘、顯示兩秒、淡出之後） | 一個 store，它的 subscribe 啟動 `every`、`after` 或 `eachFrame` 並回傳取消：`useNow`、`useBriefly`、`useExpired`（`src/ui/briefly.ts`）、`useSmoothText` |
| 跟著一個 DOM 元素的事（量尺寸、聚焦、捲動、`ResizeObserver`、聽 `window` 的事件、離開時存檔或中止） | 回傳 cleanup 的 ref callback。要跟著某個 prop 重做（`open` 變了要移動面板），用 `useCallback(…, [open])` 包起來，React 會先呼叫舊的 cleanup 再呼叫新的 |
| 對使用者的動作做反應（存草稿、通知上層、開始長按） | 寫在造成改變的事件處理函式裡 |
| id 換了要重設 state | 給元件一個 `key`，或在 render 時比對後 `setState`（`BotSheet`、`Links.tsx` 的 `useBack`） |
| 從 state 或 props 推導出來的值 | render 時算（AGENTS.md：一個值只存一次） |
| App 一啟動、runtime 一開、對話一打開就要做的事 | 不屬於任何元件：寫在 `src/app/session.ts`（`boot`、`start`、`open`），`main.tsx` 呼叫 `boot()` |
| 等一下再做 | 先找它在等的事件（`resume`、`online`、`pointerup`、資料寫入的通知）並聽那個事件；真的只有時間時用 `after`，由結束它的事件取消 |

## `src/time.ts` 的 helper

| helper | 用途 |
|---|---|
| `sleep(ms)` | 等一段時間的 Promise |
| `after(ms, run)` | 一段時間後做一次 |
| `every(ms, run)` | 每隔一段時間做一次 |
| `deadline(ms)` | 逾時就中止的 `AbortSignal` |
| `nextFrame(run)` | 下一個動畫幀做一次 |
| `eachFrame(run)` | 每個動畫幀做一次，直到取消（手勢的收合、串流文字） |
| `afterPaint(run)` | 目前這一幀畫完之後（兩個動畫幀） |

## 兩個要知道的地方

- `useSyncExternalStore` 的每次變更都立刻同步 render（SyncLane）。一幀裡會變很多次的來源會變成很多次 render；對話的 view 在串流時就是這樣，所以 `App.tsx` 用 `useBatched`（`src/ui/subscribed.ts`）：訂閱一樣走 `useSyncExternalStore`，值經過 `setState`，讓 React 把同一個 task 裡的變更併成一次 render。其他來源用 `useSubscribed`。
- 沒有 deps 的 ref callback（每次 render 都是新的函式）在每次 commit 都會被呼叫，等於每次 render 後都做。只有對話黏在底部用到（`Chat.tsx` 的 `followRender`），因為內容每次 render 都可能變高。不要拿它當一般的 effect 用。
