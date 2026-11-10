# 調查：現成的 computer use 能不能取代 `pi-mobile mcp computer`

2026-11-10。問題：市面上的 computer use（開源工具、模型廠商的原生工具、GUI 專用模型）有沒有比 `pi-mobile mcp computer`（`host/computer.go`、`host/computer_darwin.go`）更準、更省 token 的，值得直接採用或借做法。

這份是**書面調查**：版本、授權、星數讀自 GitHub API 和各家文件（附網址），schema 大小除非另外標明都是估的，沒有實際跑任何候選。基準數字來自 [computer-use-mcp-eval.md](computer-use-mcp-eval.md)、[computer-use-token-benchmark](computer-use-token-benchmark/README.md)、[agent-desktop.md](agent-desktop.md)。

## 基準：現在的做法

- 兩個工具：`screenshot`（唯讀）、`act`（一批步驟，做完回傳長邊 1,280 的 JPEG 加前景 app、視窗標題、游標）。
- 工具定義 404 tokens（o200k，實際 `tools/list`）。
- 三題表單任務各五次：總 tokens 比 computer-use-mcp 1.8.0 少 69%（未快取 input 少 30%），成功 14/15 對 15/15。agent-desktop 1.0.2 在同樣的網頁表單上是 15–47 倍 tokens。
- 省下來的主要是回合數：一次送多個步驟，動作後直接附圖。

## 開源工具

| 工具 | 版本 | 授權 | 平台 | 做法 | 工具數 | 批次＋動作後回傳 | 活躍度 |
|---|---|---|---|---|---|---|---|
| [trycua Cua Driver](https://github.com/trycua/cua) | cua-driver-rs 0.46.x（2026-11-10） | MIT | macOS、Windows、Linux | 無障礙樹＋視窗截圖，背景輸入不搶游標 | 61（定義估 >10k tokens） | 有：`run_steps` 最多 64 步，以 role／name 定位，每步可 `wait_for`／`expect`，`observe` 回傳變化的部分 | 32k 星，每天發版 |
| [Open Computer Use](https://github.com/iFurySt/open-computer-use)（仿 Codex Computer Use） | 1.1.4（2026-11-07） | MIT | macOS 14+、Linux、Windows | 無障礙樹＋截圖，`element_index` 或座標 | 11（估 2–3k tokens） | 每個動作回傳樹和截圖，**不能批次** | 2.9k 星 |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | 4.9.8（2026-11-05） | MIT | 只有 macOS 15+ | `see` 回傳元素、標註截圖、OCR；背景操作 | 約 24，可用環境變數篩 | 不能批次，動作後要再 `see` | 5.5k 星 |
| [agent-desktop](https://github.com/vercel-labs/agent-desktop) | 1.2.0（2026-11-05） | Apache-2.0 | 三平台 | 只用無障礙樹 | 每個指令一個工具（約 56） | 有 `batch` | 1.2.0 只多了原生 MCP，和 token 無關，不重測 |
| [CursorTouch/MacOS-MCP](https://github.com/CursorTouch/MacOS-MCP)、[mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use)、[automation-mcp](https://github.com/ashwwwin/automation-mcp) | — | — | macOS | 無障礙樹或截圖 | 5–12 | 不能批次 | 小或停更 |

完整的 agent 或模型，不是可以替換的工具層：UI-TARS-desktop、Microsoft UFO（偏 Windows）、Agent S、e2b open-computer-use、OmniParser（只能借來做 set-of-marks）。

Codex 和 Claude 桌面版的 computer use 是封閉的；Cua 的評測能接上它們，但兩家都說不是支援的用法，不能當產品依賴。macOS 27 沒有系統層級的 computer use，App Intents 的 MCP 只露出 App 的動作。

## 模型廠商的原生工具

| | 形狀 | 固定開銷 | 截圖建議 | 每張 1,280×831（現在的輸出） |
|---|---|---|---|---|
| Anthropic [`computer_toolset_20260801`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | 17 個成員，每個動作一個 `tool_use`，同一輪可以多個；有 `zoom` | 約 4,520 tokens（含系統提示），是我們的 11 倍 | 1024×768 到 1280×800，不超過 1080p | 1,380（`⌈w/28⌉×⌈h/28⌉`，推算） |
| OpenAI Responses [`computer`](https://developers.openai.com/api/docs/guides/tools-computer-use) | 一個 `computer_call` 帶一串 `actions`（批次） | — | `detail:"original"`，或縮到 1440×900 | 約 1,248（32px patch×1.2，推算） |
| Gemini [`computer_use`](https://aistudio.google.com/docs/computer-use) | 座標正規化到 0–999，可和自訂 function 並用 | — | 範例 1440×900 | 固定 1,120（[和尺寸無關](https://aistudio.google.com/docs/media-resolution)） |

**pi mobile 用不了原生工具**（讀 `node_modules/@earendil-works/pi-ai/dist/api/`）：pi-ai 對三種 API 都只產生 function tool（`anthropic-messages.js` 的工具轉換、`openai-responses-shared.js`、`openai-completions.js`），整個 dist 沒有 `computer_` 或 `toolset_name`。GPT 和 Qwen 經 cliproxyapi 走 chat completions，本來就沒有這種工具類型。Claude 理論上能用 `onPayload` 塞進 toolset，但回應要轉回 pi 的工具、每個結果要補 `toolset_name`，cliproxyapi 會不會原樣轉送也沒驗證；做了就是「一件事依廠商分兩種做法」。OpenAI 的文件也明說已經用 function 或 MCP 提供 UI 操作的可以沿用。

`act` 本來就是 OpenAI `computer_call` 那種「一批動作＋事後截圖」的形狀，原生工具多出來的只有模型受過那套語意的訓練。

分數方面，[OSWorld-Verified](https://leaderboard.steel.dev/leaderboards/osworld/) 前沿通用模型在 75–86（多為廠商自報），開放的 GUI 專用模型（OpenCUA-72B 45、UI-TARS-2 47.5）差很多，只適合當「把描述換成座標」的定位器，等本地 Qwen3.6 確定點不準再考慮。

## 可以借的做法

[Anthropic 的最佳實踐](https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude)和各工具的設計裡，對我們有用的：

1. **只留最近幾張截圖，分批剪**（Anthropic 建議留 3 張、每 25 輪剪一次，分批是為了保住快取）。長任務的 input 主要是累積的圖。注意 Claude 5.5 系列上刪舊圖會讓之後的 thinking block 失效，官方建議改用 server 端的 tool-result clearing 或 `prefix_mismatch_behavior:"drop_block"`。
2. **截圖長邊 1,280 → 1,024**：Claude、GPT 每張約省 35%，Gemini 不變。小控件（16px 勾選框）有失真風險，沒找到公開的解析度對準確度曲線。
3. **`zoom`／裁切區域**：全畫面用較低解析度，要看細節再放大。Anthropic 試過疊格線、切塊、換縮圖演算法，沒有穩定提升。
4. **每步的 `expect` 檢查和「做到了沒」的結果**（Cua 的 `run_steps`、Peekaboo 的 `verified`）：`act` 現在只說「停在第 N 步」，不說第 N 步有沒有生效。
5. **以 role／name 定位**（Cua、Open Computer Use）：可能減少表單上「點錯欄位」那類失敗（基準裡唯一一次失敗是漏打訂單備註），但 agent-desktop 的經驗是網頁上的無障礙樹很貴。

## 判斷和建議的量測

- **沒有現成工具可以直接取代**：原生工具 pi-ai 接不上；開源工具裡只有 Cua Driver 有「批次＋動作後回傳」，但 61 個工具的定義太大，要另外裝 macOS 常駐 App 和授權，API 每天在變。
- **值得量的**，都用 [computer-use-token-benchmark](computer-use-token-benchmark/README.md) 的三題、同一路由、每格 5 次，同時看成功率、總 tokens、**未快取 input**、秒數：
  1. **自己改**：剪舊截圖（第 1 點）和 1,024 長邊（第 2 點）。工作量最小，直接 A/B。
  2. **Cua Driver**，兩組：原封不動的 MCP；只露出 `get_window_state` 和 `run_steps` 的精簡版。看無障礙定位加 `expect` 能不能在準確度或 token 上贏過座標批次；贏了也可能只借做法。
  3. **Open Computer Use**：工具小，代表「每個動作回傳樹＋截圖、不批次」的 Codex 設計，量它在網頁表單上的代價。
- 不量：Peekaboo（不能批次，除非「不搶游標」變成需求）、agent-desktop 1.2.0、小型或停更的 macOS MCP、完整 agent 框架。

## 底層實作：學什麼、不學什麼

2026-11-10 追加。目標是讓 macOS、Linux、Windows 都有基本的畫面操控，所以讀了 Cua Driver（Rust）、Open Computer Use（Go＋PowerShell／Python）、robotgo 的純 Go 後端、nut.js 的 libnut、agent-desktop、kbinani/screenshot 的原始碼（`--depth 1` clone，讀到的檔案和行號在調查紀錄裡，這裡只留結論）。實作見 [design/computer-host.md](../design/computer-host.md) 的〈畫面操控〉。

**照著做的**
- Windows 啟動時宣告 per-monitor V2 DPI，之後一律實體像素（agent-desktop、Open Computer Use）；不宣告的話，縮放 125–150% 時截圖和點擊座標對不上，robotgo、kbinani 都要呼叫端自己換算。
- 檢查 `SendInput` 回傳送進去的數量，少了就回錯（Cua、Open Computer Use）：被 UIPI 擋掉時 Windows 不會報錯。
- 文字用 UTF-16 的 Unicode 封包，代理對不拆開，換行送真的 Enter；組合鍵帶 scan code 和 EXTENDEDKEY（Cua、agent-desktop）。
- 「為什麼不能動」是有名字的錯誤：session 0、鎖定畫面／UAC、被擋的輸入（Cua 的 diagnostics）。
- X11：XTEST 之後做 round-trip；暫借的 keycode 打完等一下再還原（Cua，xdotool 也這樣）。
- portal：先訂閱 `Response` 再呼叫、有期限、拒絕就停（agent-desktop）；restore token 每次 `Start` 後更新（robotgo）。
- 從環境變數判斷 X11 或 Wayland，一次決定（Cua）。

**避開的**
- libnut 把碼位截成 `char` 再打字：非 ASCII 全錯。
- libnut 的絕對座標用 `x*65536/w`：差一格，應是 `65535/(w-1)`。
- robotgo 從資料長度猜每個像素幾個 byte：24-bit 的顯示會猜錯；改讀 `PixmapFormats` 的 bits per pixel 和 scanline pad。
- robotgo 在 key up 後立刻還原暫借的 keycode：最後幾個字可能變成空白。
- kbinani 的 portal 截圖：先呼叫才訂閱（會漏）、`handle_token` 型別錯、沒有逾時。
- Open Computer Use 每個動作開一次 PowerShell／Python：每步都慢；我們在同一個程序裡直接呼叫系統 API。
- Cua 預設的背景 `PostMessage` 輸入：不更新按鍵狀態，`ctrl+s` 會變成 `s`；我們用前景的 `SendInput`。

**做不到或還沒做的**
- Windows 的鎖定畫面、UAC、Ctrl+Alt+Del 在安全桌面上，任何程式都看不到、按不到。前景是系統管理員權限的視窗時，非管理員送的輸入會被丟掉；不改成以管理員執行（那樣它開的 app 也都是管理員）。
- GNOME 的 portal 只認目前鍵盤配置裡的字，中文要經剪貼簿；真正的文字輸入要 libei 的 `ei_text`，沒有純 Go 的實作。GNOME 沒有公開的 API 讀前景 app。
- wlroots（Sway、Hyprland）沒做：要另外接 virtual-pointer／virtual-keyboard 協定，打中文要上傳自訂 keymap。
- 多螢幕只操作主螢幕。

