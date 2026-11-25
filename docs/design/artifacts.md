# HTML 成果：agent 寫一個 .html，你在 app 裡看、拿去分享

狀態：已實作（2026-10-24 工作區預覽與分享，2026-11-07 對話內嵌卡片）。之前的草稿想做 Claude 式的 artifact（獨立 id、版本、三種類型、自己的工具和儲存），全部拿掉，理由在最後。

## 設計與邊界

**成果就是 agent 資料夾裡的一個 `.html` 檔。** 不加工具、不加儲存、不加版本。agent 用既有的 `write`／`edit` 產生與修改（寫前讀內建 `html-page` 技能，避免弱模型各畫各的風格）；app 在對話裡以 `PageFrame` 內嵌呈現，在工作區裡全螢幕預覽，並走系統分享表分享成單檔（不給連結：手機上沒有 server）。

- **隔離與安全（實測 WebView 133）**：`<iframe sandbox="allow-scripts" srcdoc="…" referrerpolicy="no-referrer">` 不給 `allow-same-origin`，使 `location.origin` 為 `null`（`window.Capacitor`、`androidBridge` 不存在，讀 `parent.*`、`localStorage`、`indexedDB` 皆 `SecurityError`）；`srcdoc` 最前面注入 CSP（`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:`）完全阻斷網路與 CDN。
- **舊 WebView 退路**：Capacitor 的 `addWebMessageListener` 只收主 frame 訊息；退回 `addJavascriptInterface` 的舊 WebView 會把 bridge 注入所有 frame，因此不支援 `WEB_MESSAGE_LISTENER` 時不渲染、只顯示原始碼。
- **對話內嵌高度與手勢**：卡片不做內部捲動（設高度上限會吃掉外層手勢），由腳本回報高度並將左右滑動轉交給 App 側欄（輸入框與 canvas 除外）；量過的高度記在 `localStorage`，重開時畫面外的 iframe 才不會跳動。
- **上限**：HTML 檢視上限 2 MB（一般文字檔上限 512 KB，內嵌圖表較容易超過）。

## 三個環境的差別

| | 手機資料夾 | 電腦 · 直接 | 電腦 · 容器 |
|---|---|---|---|
| 檔案在哪 | 手機 app 私有目錄 | 你的家目錄 | `/workspace/<bot>/` |
| 電腦離線時 | — | 看不到、分享不了（與 agent 無法動檔案一致；要離線看先分享給自己） | 同左 |
| 歷史版本 | 沒有 | 你的 git | 容器裡的 git |

## 拿掉的選項與理由

| 拿掉 | 原因 |
|---|---|
| `artifact` 工具（create／rewrite／edit／read） | `write`／`edit`／`read` 已經是同一組動作，多一個工具是多一份要學的介面，而且和檔案是兩套真相 |
| pi-durable 的 `ArtifactDoc` family、版本、分支 | 檔案在三個環境各有自己的歸宿；手機上的對話資料庫再存一份，電腦上就有兩份會分岔。要版本，電腦上有 git |
| `markdown` 類型 | `.md` 檔已經會預覽 |
| `variants`（左右滑選方案） | 一個 HTML 裡自己做切換就是了；不值得一種類型 |
| 內建 Chart.js／ECharts | 要開網路或塞進 APK。SVG 和 canvas 畫圖表夠用，弱模型也會寫 |
| 「允許網路」開關 | 開了就是外洩的路；沒有需求前不開 |
| 從 sandbox 匯入快照到手機 | 就是「分享給自己」 |

## 待決定

1. 檢視器的 2 MB 夠不夠：內嵌幾張截圖的報告可能超過。超過時顯示「太大，請分享後用瀏覽器開」。
2. 要不要在 Bot 面板「資料夾」區塊列出最近的 `.html` 當成成果清單（先不做，看用起來找不找得到）。
3. 進階能力：列印成 PDF（`PrintManager`）、在預覽上長按選字引用。
