# Computer use：從「做得到」到「省力」

2026-11-11。接續 [computer-use-native](computer-use-native/README.md) 的四桌面量測，問：每個作業系統有哪些現成機制，能讓模型用更少的呼叫、tokens 和秒數完成同樣的事。分成四份研究：macOS（在 Mac mini M4、macOS 27 上用 purego 實測）、Linux（在 Docker 的 X11 與無頭 GNOME 48 Wayland 實測，純 Go 的 godbus）、Windows（書面研究，沒有上實機）、成本拆解（重算 2026-11-11 的 60 次原生 app、60 次網頁紀錄）。每一項都標明是實測、讀來的還是推估。

## 錢花在哪（實測，從紀錄重算）

- 一張 1280×720 截圖約 1,156 tokens（含約 50 tokens 的文字說明）。
- 每次呼叫都把之前所有截圖重送一遍：原生 app 的輸入 tokens 有 82.6% 是舊截圖（網頁 87.3%），系統提示和工具說明只佔 13.4%，文字歷史 4%，輸出 1.6%。
- 所以總 tokens 約為 `n×556 + 1,203×n(n−1)/2`（n 是模型呼叫次數；Linux 30 次的擬合，預測 4 次 9.4k、8 次 38k，實際 9.7k、38.6k）。呼叫次數翻倍，tokens 約變四倍。
- 時間 81–84% 是模型：一次呼叫約 4.0 秒模型加 1.4 秒工具，少一次呼叫約省 5 秒。
- 浪費的呼叫：原生 app 比每題最少步數多用 144 次，其中 98 次在檔案管理員那題（選錯、改名改壞再收拾）。8 次失敗裡 6 次是多一行空白，模型在截圖裡看不出來。

## Finder 那題為什麼特別貴（macOS 實測）

5 次 Finder 量測，模型第二次呼叫都是 `cmd+shift+n`、貼上「封存」、return。新資料夾的名稱欄要 312–360 ms 才拿到焦點（5 次裡 4 次；1 次 64 ms），host 只等 `stepPause` 60 ms。貼上的字落在 Finder 本身、變成一個剪輯檔，return 又把選到的檔案改名，模型再花 2–3 次呼叫收拾。

`合約.txt.txt` 是另一個原因：Finder 的改名欄只選取「收據」（不含副檔名），模型打完整檔名就多一個 `.txt`。

## 各系統的機制

| 機制 | macOS | Windows | Linux |
|---|---|---|---|
| 介面結構（文字） | Accessibility（AXUIElement）：Finder 183 個節點、64–85 ms 走完，精簡後 672 tokens；TextEdit 49 tokens（實測） | UI Automation：純 Go 呼叫 COM 約 500–800 行；Explorer 220 節點約 180 ms（agent-desktop 在 Windows Server 2019 量的，讀來） | AT-SPI2（D-Bus）：gnome-text-editor 116 tokens、23–32 ms；Nautilus 4 個檔 350 tokens、200 個檔 492 tokens（實測，X11 與 Wayland 相同） |
| 直接操作元件 | `AXPress` 選單項、`AXSelectedRows` 多選 0.4 ms、`AXFrontmost` 叫到前面 23–40 ms（實測） | Invoke、Value、Selection、ExpandCollapse pattern（讀來） | Action、EditableText、Selection；不靠座標做完編輯器題 605 ms、檔案題 5.2 秒，結果和量測的預期一致（實測） |
| 直接寫文字 | 設 `AXSelectedText`：含中文 4 次編輯共 15.8 ms，不經剪貼簿、不經輸入法（實測）；但 Finder 名稱欄設 `AXValue` 回報成功、檔案卻沒改名 | ValuePattern 寫單行欄位；注音開著時的行為要實機驗證 | `InsertText` 十行中文 2.5 ms，貼上要 1.25 秒（實測） |
| 等介面好了再動 | 每 15 ms 讀焦點、視窗標題、列數，一次 0.3 ms；AXObserver 也能在非主執行緒用；整個 Finder 題不寫死等待 1.05–1.35 秒做完，4 次都對（實測） | WinEventHook「安靜約 150 ms、上限 2 秒」（讀來） | AT-SPI 事件在輸入後 2–45 ms 到（實測）；`ctrl+s` 沒有事件，要留上限 |
| 焦點欄位的內容 | TextEdit 的 `AXValue` 是 `"alpha beta gamma\n"`，游標在最後的空行，看得出多一行（實測） | TextPattern 讀記事本內容與游標（讀來） | Text 讀回文件（實測） |
| 只截視窗 | `screencapture -l`：61 ms、34 KB，全螢幕 179 ms、87 KB（實測）；看不到選單和彈出框 | DWM 視窗邊界加現有 BitBlt（讀來） | X11 便宜；Wayland 的 `ScreenshotWindow` 只開放給白名單，不建議繞過 |
| 剪貼簿被讀的通知 | 沒有 | 延遲提供（`SetClipboardData(fmt, NULL)` → `WM_RENDERFORMAT`）：app 來讀時 host 收到訊息（讀來，要實機驗證） | 已做（2026-11-11，十行 3.8–4.8 秒 → 約 1.2 秒） |
| 打開、叫到前面 | `open -R` 15 ms 並選好檔案、`open -a` 105 ms（實測） | `ShellExecuteExW`、`explorer /select,`（讀來） | `gio open` 冷啟動 240–360 ms、已開著 41 ms（實測）；`gtk-launch` 要另外裝 |

前提條件：

- **Linux** 要有 `at-spi2-core`（完整的 GNOME 會帶進來，兩個量測容器都沒有）。在無障礙匯流排出現前就開著的 app 看不到。GTK4 的清單是虛擬化的：200 個檔只露出 16 格。GTK4 不給螢幕座標，所以在 Wayland 上不能用元件的位置來點。
- **macOS** 的 Finder 會把資料夾裡每一列都列出來：150 個檔是 5.4k tokens、550 ms，只讀看得到的列（`AXVisibleRows`）是 18 列、24 ms。
- **每一個「直接寫入」都要讀回確認**，失敗時退回貼上。

## 試過、不划算的

- **文字辨識**：macOS 用 Vision（經 JXA）第一次 13.7 秒，之後 200–400 ms，1280 的 JPEG 上中文辨識差；Linux 的 tesseract 要另外裝，從同樣的截圖只讀出 42 個字、沒有檔名。
- **整份選單樹**：macOS 3.7–4.3k tokens，還會帶出最近開過的檔名。
- **AppleScript 操作 Finder、TextEdit**：每個 app 要另外授權（-1743）。
- **其他**：`shortcuts run` 這台沒有捷徑、CLI 也建不了；Windows 的 `WM_COMMAND` 選單 id（Win11 的 app 不是傳統選單）；純 Go 的 PipeWire client 不存在，而且每張省不到 100 ms；XDamage 等畫面靜止（游標一直閃）。

## 依省的程度排序的提案

| # | 改什麼 | 在哪裡改 | 預估效果 | 依據 |
|---|---|---|---|---|
| 1 | 歷史裡只留最新一張截圖，舊的換成那張的一行文字說明 | 手機的 harness（pi-ai `onPayload`；Claude 要改用伺服器端清除工具結果，用戶端刪會破壞之後的 thinking） | 原生 app 輸入 tokens −57%，算進快取折扣成本約 −46% | 用紀錄模擬（還沒實跑） |
| 2 | 等介面真的好了再走下一步，取代固定等待；`act` 也能等「某個元件或視窗出現」 | host 核心加一個可選的平台能力 | Finder 12 → 約 8 次呼叫、87k → 約 40k tokens（推估）；Linux 讓檔案題一次 `act` 做完 | macOS 不寫死等待的 Finder 腳本 4/4 對（實測）；Linux 事件 2–45 ms（實測） |
| 3 | 截圖的文字說明附上焦點欄位：角色、值的結尾、游標或選取 | host，三個平台各讀一次 | 每步多 30–60 tokens；應能擋掉 8 次失敗裡的 6 次多一行空白和 `.txt.txt` | macOS 讀到 TextEdit 結尾的換行（實測） |
| 4 | 前景視窗的精簡介面結構，加上用編號操作（點、選、寫字） | host 三個平台、工具說明 | 介面結構比截圖便宜很多（Finder 672、Nautilus 350–492、TextEdit 49–116 tokens，截圖約 1.16k），推估檔案題 8 → 3–4 次呼叫 | 各平台實測大小；UFO² 純 UIA 的成功率只比 UIA 加視覺差 0–6 分（讀來） |
| 5 | 打字改成直接寫入欄位，讀回確認，不成才貼上 | host | macOS 4 次 15.8 ms、Linux 十行 2.5 ms，現在每行最多約 310 ms；也不經輸入法、不動剪貼簿 | 實測 |
| 6 | 檔案雜事交給 shell，`act` 多一個 `open` 步驟（並把視窗叫到前面） | 提示與 host | 檔案題 8 → 1–2 次呼叫；每次跨 app 都省掉一次「單獨點一下把視窗叫到前面」 | Agent S3 呼叫少 52%、UFO² 的 API 動作步數少 58.5%（讀來）；量測不准用 shell，要另一份 run.js |
| 7 | 截圖長邊 1024，或只截前景視窗 | host | 每張約 −30% | 依計價公式推估；清單一列約 14 px 高，要量成功率 |
| 8 | Windows 的剪貼簿被讀通知 | host | 貼上每行少等約 200 ms（照 X11、Wayland 的經驗） | 讀來，要實機驗證 |

第 4、5 項要先決定三個平台共用的格式：一行一個元件、編號、上限多少、怎麼退回截圖。第 1 項改的是手機上所有 computer use 的歷史，第 4 項是三個平台的新合約，動手前都要先做設計（architect）和影響範圍（blast-radius）。

## 要在 Windows 實機驗證的

- 記事本和檔案總管的介面結構大小與走完的時間。
- TextPattern 看不看得到結尾的換行。
- 注音開著時 `SetValue` 的行為。
- Win11 檔案總管分頁對應到哪個資料夾。
- `WM_RENDERFORMAT` 什麼時候觸發。
- 從 host 開的視窗能不能拿到前景。

## 限制

- 量測紀錄只有一個模型（gpt-6.1-sol）、每格五次；Claude 的圖片計價和快取方式不同。
- 第 1 項是模擬；第 2、4、6 項省多少是用擬合的成本公式推估，還沒讓模型實跑。
- Windows 全部是書面研究。
- 下一步是用 [run.js](computer-use-native/run.js) 對每一項做改前改後的比較（每格五次），用成功率、呼叫次數、tokens、秒數判斷。
