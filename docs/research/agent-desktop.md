# agent-desktop 與 pi mobile

調查日期：2026-10-31。對象：[vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) 1.0.2（commit `d77f910`，npm 2026-10-30 發佈）。問題：這套桌面 computer use 工具怎麼做，pi mobile 在電腦端和手機端各能借什麼。

結論先講：

- agent-desktop 是一支 CLI（另附 C 函式庫），**讀作業系統的無障礙樹**來操作 macOS、Windows、Linux 的桌面 App。它只是工具，不是 agent：每個指令印一個 JSON，觀察、動作、驗證的迴圈由呼叫它的 agent 自己跑。
- pi mobile 自己的 `pi-mobile mcp computer`（`host/computer_darwin.go`）走的是另一條路：截圖加 CGEvent 滑鼠鍵盤，無障礙只拿來讀前景視窗的標題。agent-desktop 是**不用截圖、不搶游標**的那一條。
- **2026-10-31 在 Mac mini 上實測**（第 6 節）：三個網頁表單任務都做完了，但 token 是 `pi-mobile mcp computer` 的 15–47 倍（未快取部分 2.5–8 倍），時間 2.7–8.4 倍。另外，Chrome 網頁裡的下拉選單只能靠實體輸入操作，所以在這類任務上，它「不打擾使用者」的優點並不成立。原生 App 放在背景時，headless 操作確實可行。**結論：不取代 `mcp computer`。**
- 對手機端最有價值的是兩個概念。一是**送達語意**：每個動作回報「沒送出／送出了但沒驗證／送出並驗證過」，並據此說明能不能重試。二是**元素身分不用會變的文字**，可以補 DSH Go 指紋做法的漏洞。

## 1. agent-desktop 是什麼

| 項目 | 內容 |
|---|---|
| 定位 | 給 AI agent 用的桌面 computer use：CLI + C FFI |
| 技術 | Rust；macOS 用 AX、Windows 用 UIA、Linux 用 AT-SPI |
| 規模 | Rust 約 37 萬行：core 7.7 萬、Linux 12.4 萬、Windows 8.2 萬、macOS 4.3 萬、FFI 1.5 萬、CLI 1.5 萬 |
| 歷史 | 2026-02-19 起，305 個 commit；Vercel Labs 的產品 |
| 發佈 | `npm i -g agent-desktop`，內含各平台原生執行檔；也有不需要 Node 的原生壓縮檔 |
| 授權 | Apache-2.0 |
| 指令 | 60 個名稱，56 個能用：觀察、對 ref 動作、鍵盤滑鼠、App 與視窗、通知、剪貼簿、wait、session、batch |

給 agent 的說明書內建在執行檔裡：`agent-desktop skills get desktop`、`skills get platform`，版本永遠對得上。

## 2. 最有價值的技術

### 2.1 Ref 屬於它的快照

```
agent-desktop snapshot --app Finder -i      # 只列能操作的元素，每個帶 ref
agent-desktop click @s8f3k2p9:e8            # 對那次快照的 ref 動作
agent-desktop snapshot --app Finder -i      # 再看一次確認
```

- Ref 一律帶快照 ID：`@<snapshot_id>:e<N>`，光寫 `@e8` 會被拒絕。這和 DSH Go 的 `s7` + `[5]` 同一個想法。
- 動作前做**嚴格的 ref 解析**（`CONCEPTS.md`「Strict Ref Resolution」「Graded Resolution」）：
  - 先沿著存下的樹路徑找，找不到才做有上限的廣搜。
  - 候選先用開發者給的 ID 確認（`AXIdentifier`、`AutomationId`），其次用**穩定文字**確認。
  - 只有完全沒有身分可言的元素，才退到「位置剛好唯一」。
  - 對不上回 `STALE_REF`，對到不只一個回 `AMBIGUOUS_TARGET`，不會猜。
- **穩定文字**刻意排除會變的值：輸入框的內容、被當成名稱的數值，都不拿來當身分。DSH Go 的指紋直接用畫出來的 label，輸入框內容一變，指紋就跟著變。
- 視窗身分是「handle + 行程啟動時間」：handle 被系統回收給別的視窗時，會失敗而不是點錯視窗。

### 2.2 送達語意（`docs/json-output.md`）

每個錯誤，以及每個會改動東西的動作結果，都帶 `disposition`：

| delivery | retry | 意思 |
|---|---|---|
| `not_delivered` | `safe` | 確定什麼都沒送出（參數錯、唯讀指令、找不到 App），可以重試或換做法 |
| `delivery_uncertain`、`unknown` | `unsafe` | 不知道有沒有送到 |
| `delivered_unverified` | `unsafe` | 送出了，但沒讀回確認效果 |
| `delivered_verified` | `unsafe` | 送出了，也讀回確認了 |

- 規則只有一條：**只有 `not_delivered` 能自動重試**。其他情況重做一次可能點兩次、送兩次，`toggle` 還會把自己切回去；要先讀現況再決定。
- 需要新快照的錯誤還附 `recovery`，例如 `refresh_snapshot_then_retry_original`。
- 2.5 版拿掉了 `clicked: true` 這類「每次成功都是 true」的旗標，理由是「每次都一樣的旗標什麼都證明不了」。
- 有狀態的動作（`set-value`、`type`、`check`、`toggle`…）會讀回結果，和要求矛盾就回錯誤。讀不到時是 `delivered_unverified`，不假裝成功。

### 2.3 動作前先等，等的是條件

- **Auto-wait**：對 ref 的動作預設先等目標可以操作，也就是可見、位置穩定、啟用、沒被擋住；最多 5 秒，`type` 每個字再加 30ms。暫時性的條件會輪詢，「不支援這個動作」這類條件立刻失敗，不浪費時間。
- **`wait`** 支援多種條件：
  - 元素：存在、啟用、可見、可操作、值等於某字串
  - 某段文字出現
  - 某個視窗出現
  - 選單打開
  - 事件：視窗開關、App 啟動或結束、焦點改變、彈出層出現或消失
  - 新通知

  說明書直接寫「固定 sleep 是 race」。
- 動作打開了選單、sheet、alert 時，結果的 `data.surfaces` 會列出來，下一步直接對它操作。

### 2.4 Headless：不搶焦點、不動游標

- 預設的 ref 動作只用無障礙 API 的語意動作：不搶焦點、不移動游標、不合成按鍵、不碰剪貼簿。沒有語意路徑就**失敗**，不會偷偷改用實體輸入。
- 要用實體輸入（雙擊、hover、拖曳）得加全域的 `--headed`。說明書寫明「不要為了救 headless 的失敗改用 headed」，只在使用者明確允許時用。
- 使用者可以邊用電腦邊讓 agent 操作背景的 App。pi mobile 現在的截圖加 CGEvent 做不到，一動作就搶走游標。

### 2.5 大型 App 的讀法

- `snapshot --skeleton -i --compact`：深度截在 3 層，被截斷的分支附 `children_count`，再用 `--root @ref` 鑽進其中一區；重讀那一區只換那一區的 ref。
- `complete: false`：時間用完時回傳已經讀到的部分，並標出哪些節點的子樹沒讀完，不是直接逾時什麼都不給。
- Web 包裝層（Chromium、Electron 的匿名 div）不算深度，否則密集的網頁 App 在預設深度內幾乎看不到東西。
- Electron 或 Chromium 的 App 可以 `launch --cdp`，改走 DevTools 協定。這只對新開的行程有效，它不會替使用者關掉正在跑的 App。

### 2.6 其他值得一看的

- **三態證據**：每個屬性是「有」「確定沒有」「讀不到」，三者不合併；「讀不到」不能被當成「沒有」。
- **密碼欄位**：讀的時候不給值；寫的時候不在任何訊息、步驟、讀回裡回顯內容。
- **受保護的行程**：Finder、`explorer.exe` 等系統行程拒絕關閉，比對完整名稱而不是子字串。
- **互動鎖**：同一台機器上，同一時間只有一個行程能送實體輸入；等待時不持有鎖，拿到鎖後重新解析一次 ref。
- **代理游標**：可選的「假游標」，照人手的軌跡移到目標；點擊時播 ripple、在元素周圍閃一圈框。它不動真的游標，畫面到位後才送出動作。多個 subagent 可以各有一個游標。
- **Session 與 trace**：每個動作寫 JSONL，可選擇保存動作前後的截圖，事後回放。
- 工程習慣：`docs/solutions/` 收錄過去的 bug 與教訓；`probes/` 是各平台實測的證據庫；文件裡的平台差異都附實測編號（A9-3 等）。

## 3. 要注意的地方

- **輸出是 JSON 樹**：比 pi mobile 的一行一個元素冗長，token 不一定比截圖少，要量。`-i --compact` 是預設建議。它自己的 JEV helper 就是因為「不想讓 150 個元素的 JSON 進上下文」，改由另一個模型代讀。
- **要 Node 或另外放執行檔**：npm 版需要 Node。先前評估 computer-use-mcp 時，「要有 Node」是扣分項；原生壓縮檔可以避開，但要自己放在電腦上，helper 要和執行檔放在一起。
- **macOS 的 command host**：每次快照會重用一個私有的常駐行程，閒置 15 分鐘才退出。它要求 `TMPDIR` 屬於目前使用者、權限 0700。`pi-mobile serve` 由 launchd 啟動，它的 `TMPDIR` 是否符合，**沒有驗證**。
- **權限**：依 [macos-automation.md](macos-automation.md) 的實測，從 serve 的 `/exec` 啟動的子行程，輔助使用權限算在 `pi-mobile serve` 身上。所以照理不用另外授權，但**沒有實測**。
- **Headless 的覆蓋率**：不是每個 App、每個動作都有語意路徑。Windows 的 `type` 就沒有 headless 路徑，要改用 `set-value`。失敗會明說，但成功率要實測。
- **規模**：37 萬行，嚴謹的程度建立在大量的平台實測上。pi mobile 只能借概念，不可能自己做一套。

## 4. 和 pi mobile、DSH Go 的比較

| 面向 | pi mobile 電腦端（`mcp computer`） | pi mobile 手機端（`use_phone_screen`） | DSH Go 手機操控 | agent-desktop |
|---|---|---|---|---|
| 看畫面 | 截圖 | 無障礙樹 → 元素清單 | 無障礙樹 → 分區文字 | 無障礙樹 → JSON |
| 指定目標 | 座標 | 座標 | 屏幕號 + 編號，比對指紋 | 快照 ID + ref，嚴格解析 |
| 身分依據 | 無 | 無 | 視窗、位置、角色、label | 樹路徑、開發者 ID、穩定文字；位置是最後手段 |
| 動作方式 | CGEvent，會搶游標 | 無障礙手勢 | 無障礙動作，必要時手勢 | 語意動作；實體輸入要 `--headed` |
| 動作前 | 無 | 無 | 核對指紋 | 等到可以操作，最多 5 秒 |
| 動作後 | 截圖 | 等畫面安靜後讀新畫面 | 等穩定、回報有沒有變、讀回 | 讀回狀態、回報送達語意 |
| 能不能重試 | 沒說 | 沒說 | 被拒絕時說「不要重試」 | `disposition.retry` 明說 |
| 等待 | 固定（Enter／Esc 後 400ms） | 固定 `wait {ms}` | 只有事件安靜 | 元素、文字、視窗、事件、通知 |
| 給使用者看 | 無 | 無 | 懸浮條狀態列 | 代理游標，有 ripple 和外框 |

## 5. 值得 pi mobile 借的，按效益 ÷ 成本排

1. ~~在電腦上實測 agent-desktop~~：已經測過（第 6 節），不取代 `mcp computer`。可以借的是它在原生 App 上的 headless 操作，見第 6 節最後。
2. **送達語意**：讓 `use_phone_screen`、`use_browser`、`mcp computer` 的失敗分成「沒送出，可以重試」和「可能已經送到，先看畫面」。pi mobile 現在的批次是「停在第 N 步，前面的都跑了」，但沒有說第 N 步本身有沒有送出。這和 pi-durable 的 `replay: safe/unsafe` 是同一個問題的兩個層次。
3. **身分不用會變的文字**：要做 [dsh-go.md](dsh-go.md) 第 3 項的「元素編號 + 動作前核對」時，指紋裡輸入框只用 viewId、hint 和角色，不用內容，否則每次打字都會讓自己的 ref 過期。
4. **條件式等待**：和 [mika.md](mika.md) 的第一項是同一件事。agent-desktop 的條件清單（元素可操作、文字出現、視窗出現、彈出層出現）可以直接當成規格。
5. **動作後列出新出現的彈出層**：Android 的對話框、底部面板、選單也適用，讓模型下一步直接看那一層。
6. **代理游標的提示**：DSH Go 只有懸浮條上的一行字。可以考慮在手機上點擊時，短暫在目標元素周圍閃一圈框，讓使用者看得出 agent 點了哪裡。這是新的 UI，要先和使用者確認要不要。

不借的：

- 跨平台的整套嚴謹度（三態證據、互動鎖、句柄回收）：手機上只有一個前景、一個使用者，大部分問題不存在。
- JEV helper：另一個模型代讀畫面，等於多一層成本和多一個供應商。

## 6. 在 Mac mini 上實測（2026-10-31）

### 怎麼測

- 機器：Mac mini（M4，macOS 27.0.1），1920×1080。agent-desktop 用 GitHub Release 的原生壓縮檔 v1.0.2（`aarch64-apple-darwin`，SHA-256 與 `checksums.txt` 相符，ad-hoc 簽章），不經 npm 和 Node。
- 題目、治具、判分、模型都沿用 [computer-use-token-benchmark](computer-use-token-benchmark/README.md)：
  - 三題：訂單、報銷、專案
  - `fixture.html` 跑在隔離的 Chrome profile 裡
  - 結束後比對整份資料狀態
  - 模型是 `gpt-6.1-sol`，思考程度 low
  - 上限 80 次回應／480 秒
- 兩組：
  - **own**：今天 HEAD 建的 `pi-mobile mcp computer`，提示詞和原本相同。
  - **ad**：只給一個工具 `agent_desktop {args}`，說明是 `agent-desktop skills get desktop` 的全文。提示詞改成「只用 agent_desktop」，另加一句「使用者允許用 `--headed` 實體輸入」。
  - 擋掉 `launch`、`close-app`、剪貼簿、`--cdp`，以免碰到其他 App。
- 兩組都從這台的 shell 直接跑，不經 `pi-mobile serve` 的 `/exec`。`/exec` 要配對金鑰，主機只存雜湊，要測得先配對一台新裝置，所以這次沒測。從 serve 啟動時的 `TMPDIR` 和權限歸屬，仍然**沒有驗證**。
- 每組每題各跑一次（pilot）。差距大到加跑也不會改變結論，所以沒有加跑。

### 結果

| 題目 | 組 | 成功 | 秒數 | 模型回應 | 工具呼叫 | 輸入 tokens（含快取） | 未快取 | 輸出 |
|---|---|---|---|---|---|---|---|---|
| 訂單 | own | ✓ | 40 | 8 | 7 | 40,605 | 15,261 | 447 |
| | ad | ✓ | 124 | 34 | 33 | 672,049 | 38,705 | 1,188 |
| 報銷 | own | ✓ | 41 | 8 | 7 | 40,799 | 10,719 | 515 |
| | ad | ✓ | 345 | 73 | 72 | 1,916,758 | 84,822 | 3,603 |
| 專案 | own | ✓ | 60 | 12 | 11 | 89,652 | 16,564 | 574 |
| | ad | ✓ | 164 | 44 | 43 | 1,344,921 | 55,193 | 1,505 |

和 own 相比，ad 的含快取輸入是 15–47 倍，未快取部分 2.5–8 倍，時間 2.7–8.4 倍。

### 為什麼差這麼多

- **一回合一個動作**：ad 組每回合最多只叫一次工具。own 的 `act` 一次批次好幾步，例如「點下拉、按下、Enter」或「點欄位、全選、打字」。agent-desktop 也有 `batch` 指令，但模型只在報銷題用了 4 次。
- **快照很大，而且一直累積**：一次 `snapshot -i --compact` 是 11–14 KB 的 JSON，表格的每個儲存格會出現兩次（逐列一次、逐欄一次）。快照留在對話裡，每回合重送，所以 token 隨回合數超線性成長。三題的工具輸出各有 10–15 萬字元，一大半是快照。
- **下拉選單**：三題都有 HTML `<select>`，在 macOS 的 Chrome 上：
  - headless 的 `select` 一律等到 5 秒逾時（`delivered_unverified`）。
  - `set-value` 送出後讀回還是原值（`ACTION_FAILED`，`post_action_verification`）。
  - `expand` 打開了選單，`--surface menu` 卻說找不到選單。
  - `--headed select` 也一樣逾時，因為 `select` 在 headed 模式下仍走語意路徑。
  - 用 `--headed click` 打開選單後，`--surface menu` 讀得到選項，但點選項回 `STALE_REF`，原因是 `expected_app: "Google Chrome"`、`actual_app: "Chrome"`，看起來是 agent-desktop 的 bug。
  - 唯一可行的路：`--headed click` 打開 → `snapshot --surface menu --include-bounds` 取座標 → `--headed mouse-click --xy`。全程是實體輸入，會移動游標。
  - 模型照說明書，headless 失敗後先停下來；允許 `--headed` 後才繞過去，每題用了 7–31 次實體輸入。所以在這類網頁表單上，「不搶焦點、不動游標」不成立。
  - 對照：own 用 CGEvent 實體點擊加方向鍵、Enter，一步就選好。agent-desktop 的按鍵是 `CGEventPostToPid`（只送給該行程），打不進原生的選單，這可能是差別所在（推測）。
- 其他錯誤：數字欄位 `set-value 560` 讀回不符；`--headed type` 回 `ACTION_NOT_SUPPORTED`；`press ArrowDown` 不是合法鍵名（要寫 `down`）；本機另有一個 Chrome 行程（使用者自己的）時，用 `--app "Google Chrome"` 會得到 `AMBIGUOUS_TARGET`。`list-apps` 有一次等了 384 次仍回「application inventory did not stabilize」的逾時。

### 原生 App 放在背景：可行

不經模型，手動測：打開「計算機」，再讓 Finder 到前景，然後用 headless `click` 依序按 AC、7、3、×、2、=。

- 讀回顯示 `73 × 2`、`146`，結果正確。
- 前後 `lsappinfo front` 都是 Finder，焦點沒有被搶走。
- 每次點擊都是 `delivered_unverified`，沒有讀回驗證；要確認結果，得自己再讀一次。
- App 名稱要用系統語言的名稱（「計算機」）。用 `Calculator` 會回 `APP_NOT_FOUND`。

### 結論

- **不取代 `pi-mobile mcp computer`**：在網頁表單上，它慢 3–8 倍，token 也多得多，還得靠實體輸入。
- **值得留意的是原生 App 的背景操作**：這是截圖加 CGEvent 做不到的。如果日後有「邊用電腦邊讓 pi 在背景操作原生 App」的需求，可以讓 `mcp computer` 對原生 App 走 AX 的語意動作（`AXPress`、`AXValue`）。這要另外量，這次只確認了可行。
- 如果要讓 Bot 自己用 agent-desktop（例如寫成 skill），至少要做到兩件事：
  - 鼓勵用 `batch`。
  - 舊快照不要一直留在上下文裡。
- 測試腳本（`adbench.mjs`）和每次的完整紀錄留在 session 的 scratchpad，沒有放進 repo。
