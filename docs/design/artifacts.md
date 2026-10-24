# HTML 成果：agent 寫一個 .html，你在 app 裡看、拿去分享

狀態：第 0、1 階段做完（2026-10-24，模擬器）；電腦兩種環境待 S24 驗證。2026-10-24 改寫；之前的草稿想做 Claude 式的 artifact（獨立的 id、版本、三種類型、自己的工具和儲存），這版全部拿掉，理由在最後。

## 目標

agent 在它工作的任何一個環境（手機資料夾、電腦直接、電腦容器）產出一份 HTML——報告、比較表、圖表、一頁式的小工具——你在 app 裡全螢幕看，按一下就能分享成一個 `.html` 檔給別人。不給連結：手機上沒有東西可以當 server，收到的人開檔案就行。

## 一句話的設計

**成果就是 agent 資料夾裡的一個 `.html` 檔。** 不加工具、不加儲存、不加版本。agent 用它本來就有的 `write` 和 `edit` 產生和修改；app 把 `.html` 當成可以「打開看」和「分享」的檔案。

這樣三個環境自動都有：`write` 在哪個環境跑，檔案就在哪裡；app 讀檔案走的是同一個 `Workspace`（包著那個環境的 `ExecutionEnv`）。

## 要改的地方

### 1. agent 這邊：一句提示，和一個技能

`files` 和 `sandbox` 的說明各加一句：

> To give the user something to look at or send on (a report, a comparison, a chart, a small tool), write a self-contained `.html` file: inline CSS and JS, SVG or canvas for charts, no CDN or network. The app shows it and can share it; tell the user the file name.

不需要新工具。`write` 已經會在對話裡留一個步驟卡片，卡片上有「開啟檔案」。

風格放在 `html-page` 技能（`src/agent/skills/html-page.md`，35 行），模型寫 `.html` 前讀一次：像一份乾淨的文件，不像 app 或 landing page；結論先講；一個強調色加灰；圖表自己畫 SVG、標上數值；自包含、不連網。只講抽象的樣子，不給版型，留給模型發揮。沒有技能時兩個弱模型各做各的（圓角卡片、英文裝飾字、多色圓餅），有了之後長得像同一個人做的。

### 2. 手機資料夾也有工作區

`runtime.workspace(id)` 現在只對電腦回 `Workspace`；手機資料夾的 `Workplace.phone` 有 `env()`，同樣包成 `new Workspace(env, "/")` 就好。這也順便解決掛很久的「手機上的『檔案』頁」：工作區的檔案分頁在三個環境都在，git 分頁只在電腦。

### 3. 檔案檢視器會渲染 HTML

`FileViewer` 現在對 `.html` 顯示原始碼。改成和 `.md` 一樣有「預覽／原始碼」兩個模式，預覽是：

```html
<iframe sandbox="allow-scripts" srcdoc="…" referrerpolicy="no-referrer">
```

- 不給 `allow-same-origin`：iframe 的 origin 是 `null`，碰不到 app 的 localStorage、IndexedDB、cookie。
- `srcdoc` 最前面塞一個 CSP：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:`。沒有網路，對話裡的東西送不出去，也不能載 CDN。
- Capacitor 的 bridge：`MessageHandler.java` 用 `addWebMessageListener` 時只收主 frame 的訊息。舊 WebView 會退回 `addJavascriptInterface`，那會注入所有 frame；原生端檢查 `WebViewFeature.WEB_MESSAGE_LISTENER`，不支援就不渲染、只給原始碼。
- 大小：HTML 上限 2 MB（`FileViewer` 的文字上限是 512 KB，圖表用 SVG 很小，內嵌幾張圖就會超過 512 KB）。
- 模型寫的 HTML 不用額外防 prompt injection 的「內容」：它看不到對話、沒有網路、叫不到 plugin，最多就是畫面難看。

### 4. 檢視器頂列多一個「分享」

對任何打開的檔案都有效，不只 HTML。按下去：讀檔（手機直接讀；電腦經連線讀），交給現有的 `AppsPlugin.share`（寫到 `cacheDir/share`，開 Android 分享表）。LINE、email、Drive、「儲存到裝置」都在分享表裡，所以「下載」不用另做。

和 agent 的 `share` 工具是兩條路：工具是 agent 主動分享；這個是你在看的時候自己按。

### 5. 對話裡怎麼找到它

- `write`／`edit` 的步驟卡片已經有「開啟檔案」，點了就進檢視器。
- agent 的回答裡提到檔名時，不另外做卡片。要的話第二階段再把回答裡的 `xxx.html` 變成可以點的。
- 排程跑出來的報告（早晨簡報）：完成通知點進對話，卡片就在最後一輪。

## 三個環境的差別

| | 手機資料夾 | 電腦 · 直接 | 電腦 · 容器 |
|---|---|---|---|
| 檔案在哪 | 手機 app 私有目錄 | 你的家目錄 | `/workspace/<bot>/` |
| 看 | 直接讀 | 經 Tailscale 讀 | 同左 |
| 分享 | 直接讀再交分享表 | 讀過來放 `cacheDir/share` 再分享 | 同左 |
| 電腦離線時 | — | 看不到、分享不了，檢視器顯示連不上 | 同左 |
| 歷史版本 | 沒有 | 你的 git | 容器裡的 git |

電腦離線時看不到，是接受的：它和「電腦離線時 agent 也動不了檔案」是同一件事。要離線還能看，分享給自己（存到裝置）就有一份。

## 分階段

0. **實測**（模擬器，WebView 133）：`sandbox="allow-scripts"` 的 iframe 裡 `location.origin` 是 `null`，`window.Capacitor` 和 `androidBridge` 都不存在，讀 `parent.*`、`localStorage`、`indexedDB`、`cookie`、`top.location` 全部 SecurityError；CSP `<meta>` 放在 `srcdoc` 裡，`fetch`、`<img src=https://…>`、WebSocket 都被擋；`<script>` 照跑。主 frame 的 `androidBridge` 有 `addEventListener`（`addWebMessageListener` 的那種），檢視器以此判斷能不能渲染，退回 `addJavascriptInterface` 的舊 WebView 只給原始碼。
1. 做完：那句提示（`SHOWN_AS_FILE`，三個環境的說明都有）、手機資料夾的工作區（沒有 git 分頁）、`.html` 的預覽／原始碼、「分享」。順手修的：工作區路徑在根目錄會變成 `//x`；`Workspace.read` 用了 `head -- `，just-bash 的 `head` 不認 `--`。code mode 或 bash 的輸出裡出現 `.html` 路徑時，步驟卡片也給「開啟」。模擬器上 GPT 6 Luna 一次寫出含 SVG 長條圖的頁面，預覽正確，分享表列出 `.html` 檔。
2. 回答裡的檔名可點；「列印成 PDF」（`PrintManager`）；在預覽上長按選字→「引用」放進輸入框。

## 上一版草稿拿掉的，和為什麼

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
2. 步驟卡片的「開啟檔案」在手機資料夾現在能不能用（它走 `openWorkspace`，第 2 點做了應該就通）。
3. 要不要在 Bot 面板「資料夾」區塊列出最近的 `.html`，當成成果清單。先不做，看用起來找不找得到。
