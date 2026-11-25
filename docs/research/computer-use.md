# Computer use：量到什麼、選了什麼

2026-10-23 至 2026-11-11。整理 `pi-mobile mcp computer`（`host/computer/`）從評估替代品、四桌面量測到改成文字為主的結論、數字、否決選項與平台怪癖。原基準測試腳本與原始 run 資料（`computer-use-token-benchmark/`、`computer-use-native/`）及三份研究原文已併入本檔（原始檔案見 git 歷史）。

## 結論

自寫並維持 `pi-mobile mcp computer`（純 Go，不依賴 Node），提供 `screenshot`（唯讀）與 `act`（批次步驟＋做完附結果）兩個工具，預設以無障礙樹文字為主、截圖為備案。沒有現成開源工具或廠商原生工具可直接取代：

- **`computer-use-mcp` 1.8.0**：工具定義 4,108 字元（899 o200k_base tokens），不能批次、每個動作後要另截圖、macOS 26+ 走 `screencapture` 存 PNG 再轉檔（每張 2–7 秒）、依賴 Node；當時連截圖都標 `readOnlyHint: false`（每題 4–22 次核准；之後 pi 移除核准機制，仍因回合數、速度與 Node 依賴不採用）。
- **其他開源工具（書面調查，2026-11-10）**：
  - **Cua Driver**（0.46.x，MIT）：唯一有「批次＋動作後回傳＋`expect`＋差分」，但約 61 個工具定義估 >10k tokens、需另外裝 macOS 常駐 App 與授權，且 API 每日變動。
  - **Open Computer Use**（1.1.4，MIT）、**Peekaboo**（4.9.8，MIT，僅 macOS 15+）、小型 macOS MCP：皆不能批次。
  - **agent-desktop**：網頁表單實測 15–47 倍輸入 tokens（見 [references.md](references.md)），1.2.0 僅多原生 MCP、無關 token。
- **模型廠商原生工具（讀 `node_modules/@earendil-works/pi-ai/dist/api/`）**：pi-ai 對 Anthropic、OpenAI Responses、Chat Completions 都只產生 function tool，沒有 `computer_` 或 `toolset_name`；Anthropic `computer_toolset_20260801` 固定開銷約 4,520 tokens（自寫版 11 倍）；GPT／Qwen 經 cliproxyapi 走 chat completions 本來就不支援。硬塞 `onPayload` 會造成「同一件事依廠商分兩種做法」。
- **開放 GUI 專用模型（書面）**：OSWorld-Verified 前沿通用模型 75–86，OpenCUA-72B（45）、UI-TARS-2（47.5）落差大，僅適合在本地小模型點不準時當座標定位器。

## 量測結果（皆為實測）

### 1. 初版對照：macOS 三題（2026-10-23）

calc、settings、textedit 各跑兩次（Mac mini M4、macOS 27），對比 `computer-use-mcp` 1.8.0 與自寫 `pi-mobile mcp computer`（全部答對）：

- **GPT 6.1 Sol**：秒數 57→29（calc）、61→28（settings）、105→29（textedit）；呼叫 8→4、8→4、15→4.5；輸入 tokens 少 40–60%（原本 83k–373k，自寫約 41k）。
- **Claude Opus 5.5**：秒數 40→14、41→24、42→24；呼叫 6→3、7→4、5→4。
- **截圖**：`screencapture -x -m -t jpg` 75 ms（PNG 257 ms），縮至長邊 1,280 JPEG 品質 70 約 90 KB；工具定義 1,569 字元（對照 4,108）。

### 2. 合成表單 30 次 A/B 與四桌面重跑（2026-10-24、11-11）

同路由 `gpt-6.1-sol`（low reasoning，直接 agent-loop，非手機 app 端到端）、三個多步驟網頁表單任務（訂單修改、三階段報銷、跨頁批次任務），每題每組 5 次，以完整 state oracle 判分：

| 指標（15 次合計） | pi-mobile MCP | computer-use-mcp 1.8.0 | 差異 |
|---|---:|---:|---|
| Input + output（含快取） | 1,484,263 | 4,812,272 | −69.2%（雙勝 14 組 −68.4%） |
| 未快取 input | 367,875 | 525,812 | −30.0%（不可將總 token 當帳單比例） |
| 模型回應次數／MCP 呼叫 | 184 ／ 169 | 520 ／ 505 | 回應少 64.6% |
| 回傳截圖數／耗時中位數 | 169 ／ 52.3 秒 | 141 ／ 139.0 秒 | 圖較多但回合少 |
| 成功 | 14/15 | 15/15 | 1 次漏填備註 |

- **Schema microbenchmark**（tiktoken 0.14.0，MCP `tools/list` canonical JSON）：pi-mobile 404 vs 對照 899 o200k_base tokens（−55.1%）；cl100k_base 382 vs 893（−57.2%）。2026-11-11 多螢幕 `display` 參數後為 452 o200k_base tokens。
- **漏填備註修補（2026-10-24）**：Chrome/macOS 原生 `<select>` 關閉動畫吞掉緊接點擊，文字落進 `SELECT` 而非 `TEXTAREA`。`act` 在明確的 `return/enter/esc` 後若還有下一步改等 400 ms（一般步驟仍 60 ms），失敗即停並附現場截圖。固定重播 **0/10 → 10/10**，訂單任務 **4/5 → 5/5**（中位 input 63,186 → 51,279，平均 66,182.8 → 67,117.2，不宣稱省 token）。不是完整的 UI-idle 偵測；對 Chrome 原生選單 `AXFocusedUIElement` 回空值故未採用。
- **2026-11-11 四桌面重跑（僅 pi-mobile，各 15 次）**：macOS 15/15（1,135,546 tokens，未快取 384,068）、Windows 11 15/15（863,441 / 323,798）、Linux X11 15/15（841,826 / 310,247）、Linux Wayland 15/15（847,444 / 304,769），中位 48–54 秒、10–11 呼叫。網頁實務應走 CDP，這批僅用於對照 MCP 成本。

### 3. 四桌面原生 App 60 次量測與文字優先改進（2026-11-11）

同路由 `gpt-6.1-sol`（low）、1920×1080，每桌面三題（`editor`、`files`、`crossapp`）各 5 次、檔案系統判分：

- **純截圖基線**：macOS 12/15（493,943 tokens，Finder 12 次呼叫貴一倍）、Windows 11 11/15（386,516）、Linux X11 14/15（296,907）、Linux Wayland 15/15（270,642）。8 次失敗裡 6 次是 TextEdit／記事本把結尾換行顯示成空行，模型多打一個換行；另 2 次為 Finder 改名成 `合約.txt.txt`（選取不含副檔名）與 X11 容器以 root 跑 Nautilus 當掉。
- **成本拆解（60 次原生＋60 次網頁重算）**：
  - 一張 1280×720 截圖約 1,156 tokens（含約 50 tokens 文字）。
  - **舊截圖佔輸入 tokens 82.6%（原生）／ 87.3%（網頁）**，系統與工具說明 13.4%，文字歷史 4%，輸出 1.6%。總 tokens 約 `n×556 + 1,203×n(n−1)/2`（呼叫翻倍、tokens 約變四倍）。
  - 時間 81–84% 在模型（約 4.0 秒模型＋1.4 秒工具／次）。
- **加上「焦點欄位資訊＋等待焦點可輸入」後（macOS 15 次 A/B）**：15/15，呼叫 85 → **74（−13%）**，tokens 347,264 → **258,209（−26%）**，秒數 495 → **380（−23%）**。Finder 原本 `cmd+shift+n` 後名稱欄要 312–360 ms 才拿到焦點（4/5 次），60 ms 就貼字導致變成剪輯檔；等焦點後 0 次發生。
- **改成「無障礙樹文字為主、截圖為備案」後（每平台 15 次，系統提示未改）**：
  - **macOS**：15/15，tokens 248,935 → **163,837（−34%）**，秒數 354 → 340，圖從每題 2–8 張降到 0–2 張。
  - **Linux X11**：15/15，tokens 268,888 → **158,326（−41%）**，秒數 374 → 319。GTK4 格子無 AT-SPI 動作且 `GetExtents` 回 0，第一版雙擊開不了資料夾（tokens 飆到 325,928）；改成「選取再按 return」並列出後面視窗後，files 每次 6 呼叫、0 張圖。
  - **Windows 11（垂直第二螢幕，主螢幕播影片）**：截圖版 11/15（258,364 tokens、425 秒）→ 文字版 **15/15**（252,695 tokens、344 秒；editor 1/5 → 5/5）。元件清單原讀前景視窗抓到主螢幕瀏覽器（9k 字），改讀目標螢幕最上層視窗並替文件元件附最後幾行後修復。
- **各平台無障礙樹成本**：macOS Finder 183 節點 64–85 ms / 672 tokens（150 檔全部讀 5.4k tokens / 550 ms，改 `AXVisibleRows` 僅 18 列 / 24 ms），TextEdit 49 tokens（實測）；Linux AT-SPI2 gnome-text-editor 116 tokens / 23–32 ms、Nautilus 4 檔 350 / 200 檔 492 tokens（GTK4 虛擬化只露 16 格，實測）；Windows UIA Explorer 220 節點約 180 ms（讀自 agent-desktop）。

## 試過但不划算的方案

- **OCR**：macOS Vision（JXA）首次 13.7 秒、之後 200–400 ms，1280 JPEG 中文辨識差；Linux tesseract 須另裝且同圖只讀出 42 字、無檔名（實測）。
- **整份選單樹**：macOS 3.7–4.3k tokens，且會洩露最近開過的檔名（實測）。
- **AppleScript 操作各 App**：每個 App 要另外授權（`-1743`）。
- **其他**：`shortcuts run` CLI 建不了捷徑；Windows `WM_COMMAND` 對 Win11 新選單無效；無純 Go PipeWire client 且每張省 <100 ms；XDamage 因游標閃爍無法判畫面靜止。

## 平台底層怪癖與已避開的坑

實測與讀 Cua Driver / Open Computer Use / robotgo / libnut / agent-desktop / kbinani 原始碼整理（實作見 [design/computer-host.md](../design/computer-host.md)）：

- **macOS**：
  - `AXUIElementCreateSystemWide()` 的 `AXFocusedUIElement` 在背景程式回 `-25204`，須從最前視窗的 app pid 查詢（實測）。
  - `AXSelectedText` 可直接寫中文（4 次 15.8 ms），但 Finder 名稱欄設 `AXValue` 回報成功卻沒改名——直接寫入都須讀回確認、失敗退回貼上（實測）。
  - 選單與彈出選單不在視窗樹裡（未做）。
- **Linux（X11 / Wayland）**：
  - **Wayland 空剪貼簿當機（實測）**：剪貼簿為空時讀取會讓 `xdg-desktop-portal-gnome` 48 當掉，之後到重登前皆回 `Invalid state`、中文無法輸入；portal 又會丟失工作階段開始時的擁有者，host 須追蹤 `SelectionOwnerChanged`，僅確定別人擁有文字時才讀。
  - **X11**：XTEST 後須做 round-trip；暫借 keycode 打非鍵盤字元須等一下再還原（robotgo 立刻還原會吃掉末字）；不可從資料長度猜 bpp，須讀 `PixmapFormats` 的 bpp 與 scanline pad。
  - **portal**：須先訂閱 `Response` 再呼叫並設逾時（kbinani 先呼叫會漏）；`restore_token` 每次 `Start` 後更新。GNOME 無公開 API 讀前景 App、非鍵盤字須走剪貼簿（真正輸入要 libei `ei_text`，無純 Go 實作）；Wayland 尚無通用方式將後面視窗叫到前面；wlroots（Sway／Hyprland）未支援。
  - **AT-SPI2**：需裝 `at-spi2-core`；在匯流排啟動前開的 App 看不到；GTK4 無螢幕座標（Wayland 不能靠座標點元件）。
- **Windows**：
  - 啟動須宣告 per-monitor V2 DPI，否則縮放 125–150% 時截圖與座標對不上（實作讀碼）。絕對座標為 `65535/(w-1)`，非 libnut 的 `65536/w`。
  - 須檢查 `SendInput` 回傳數量：被 UIPI（前景為管理員視窗）擋下時不會報錯。不用 `PostMessage`（不更新按鍵狀態，`ctrl+s` 變 `s`）。文字送 UTF-16 `KEYEVENTF_UNICODE`（代理對不拆開，換行送真 Enter）；組合鍵帶 scan code 與 `EXTENDEDKEY`。
  - 螢幕閒置關掉後截圖仍是舊畫面：閒置 >30 秒先送滑鼠事件叫醒（實測）。
  - 鎖定畫面、UAC、Ctrl+Alt+Del 在安全桌面、Session 0 無畫面，均不可操作（回具名錯誤）；不改以管理員執行以免子程序全提權。
- **跨平台通用**：多螢幕僅操作主螢幕（或指定 `display`）；所有實驗均為單模型（多數為 `gpt-6.1-sol`）、每格 5 次，Claude 計價與快取結構不同。

## 還沒做的最佳化候選

- **歷史只留最新 1–3 張截圖（分批剪）**：用原生 app 紀錄模擬可省輸入 tokens **−57%**（含快取約 **−46%**）；注意 Claude 5.5 系列在客戶端刪舊圖會破壞後續 thinking block，須改用 server 端 tool-result clearing 或 `prefix_mismatch_behavior:"drop_block"`。
- **截圖長邊 1,280 → 1,024 或只截前景視窗**（`screencapture -l` 61 ms / 34 KB vs 全螢幕 179 ms / 87 KB，但看不到選單／彈出框；清單一列約 14 px，須實測準確度）；`zoom` 裁切放大（Anthropic 實測格線／切塊無穩定提升）。
- **Windows 剪貼簿延遲通知**（`WM_RENDERFORMAT`）與待實機驗證項目：注音開著時 `SetValue`、Win11 檔案總管分頁對應資料夾、host 開的視窗能否拿到前景。
