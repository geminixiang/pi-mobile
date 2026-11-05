# 2026-11-05 的 WebView 卡死

現象：S24 上 pi 白畫面 54 分鐘，渲染主執行緒約 92% CPU，頁面不回應 DevTools。強制停止後恢復，資料完好。

## 時間線

| 時間 | 事件 | 來源 |
|---|---|---|
| 09:00:00 | 每日排程背景喚起 pi | usagestats |
| 09:00:03–09:01:03 | 回合正常跑 `bash`、`web_search` | entries |
| 約 09:01:12 | 腳本同時對三個第三方網址跑 `web_fetch({ render: true })` | entries |
| 09:54:54 | 強制停止 | exit-info |
| 09:54:59 | 這一步結果回來，`Wall time 3227.5 seconds`，三個 `web_fetch` 都被中斷 | entries |

同一個對話 242 次工具呼叫裡，結果晚 10 分鐘以上的只有兩次，兩次都是並行的 `web_fetch`，也都有同一個網站（〔跑過〕統計 entries）。

## 原因

`Page.check`、`Page.render` 在 App 裡開第二個 WebView，用的是 pi 的預設 profile。同一個程序裡同一個 profile 的 WebView 共用渲染程序和它的主執行緒，所以網頁的 JS 空轉時 pi 也動不了。`Render` 的 30 秒期限只在 `evaluateJavascript` 的回呼裡判斷，回呼不來就永遠不結束。

〔跑過〕模擬器：`Page.render` 載入 `setTimeout(() => { for (;;) { [].concat([1]); } }, 100)` 的網頁後，pi 不再回應，主執行緒 100%，3 分鐘沒恢復。一般開機 0%。

**沒有證明的：** 當天是哪個網頁空轉。同樣三個網址之後在模擬器上渲染正常，3–5 秒完成。卡死當下沒有堆疊，logcat 也已被覆蓋。

## 修正

- `Page.check`、`Page.render` 改用專用 profile `web-pages`，有自己的渲染程序。〔跑過〕S24 上同一個空轉網頁渲染時，pi 的計時器最長只隔 102 ms，33 秒後回報頁面沒有回應，渲染程序結束，之後再渲染正常。
- 看門狗。〔跑過〕讓 pi 自己的頁面空轉，前景和回合在背景跑時，都在 30 秒左右重開並恢復，背景時不會跳到前面。
- `onRenderProcessGone`：以前渲染程序一死，WebView 會把 App 一起殺掉。08:43 的 `SIGKILL` 緊接在渲染程序 `LOW_MEMORY` 後 109 ms，應該就是這樣（推測）。
- 工作列留著 Activity 時，排程的 intent 走 `onNewIntent`，以前沒人處理，pi 會蓋在使用者的 App 上。09:00:00 到 09:00:09 就是這樣（推測）。

S24 上也跑過：pi 頁面空轉時約 30 秒重開，App 程序不變，資料完好。排程回合在背景時的恢復和 `onNewIntent` 只在模擬器跑過。

- log 寫到原生端的 `device.log`，重開後還在。〔跑過〕模擬器上頁面空轉、看門狗重開後，紀錄有 `renderer.restarted`、`renderer.gone` 和之前的內容。

## Bot 的瀏覽器

`BrowserTab` 不用隔離。〔跑過〕模擬器和 S24 上，它的空轉頁面都有自己的渲染程序（profile `bot-<id>`），pi 全程回應，看門狗沒有觸發。

但關掉分頁、刪掉 profile 都停不了空轉，渲染程序繼續吃滿 CPU、記憶體還在漲。所以最後一個分頁關掉時要明確結束渲染程序，分頁 20 秒沒回應時也一樣。

## 為什麼不用獨立程序

第一版把 `Page` 搬到獨立程序 `:webpages`，後來換成 profile。S24 量到（〔跑過〕各 3 次）：

| | 獨立程序 | 專用 profile |
|---|---|---|
| 第一次 `check` | 354–414 ms | 141–191 ms |
| 之後的 `check` | 35–37 ms | 24–29 ms |
| 渲染 | 約 2.55 s | 約 2.53 s |

profile 少約 140 行，也少一套 Messenger 協定，隔離做法只剩一種。代價是 WebView 的瀏覽器端（網路、GPU、回呼）回到 pi 的程序：網頁弄垮瀏覽器端會帶走 pi，看門狗救不了，要靠 App 重開後接續。Bot 的瀏覽器本來就是這樣。這個風險沒有資料。

## 還留著的

- `web.ts` 的 `htmlToText` 還在 pi 的主執行緒解析第三方 HTML。
