# pi-durable、pi-ai、pi-env：pi-mobile 依賴的行為

2026-10-23。pi-mobile 的 agent 迴圈是 pi-durable 的 Harness，模型呼叫走 pi-ai，電腦上的檔案和指令走 pi-env daemon。這份整理我們實際依賴的規則，以及我們有沒有照著用。出處是 `~/github/pi`（`74f4686`）：
- `packages/durable/docs/spec.md`（以下寫成 spec §節）
- `packages/env/docs/protocol.md`、`semantics.md`
- `packages/ai/README.md`

## Harness 的基本保證

- **所有看得到的進度都是持久的**：沒有只存在記憶體的發布路徑；外部的副作用不在儲存交易裡執行（spec §1 invariants 3、4）。
- **名詞**（spec §1）：
  - turn 是一次助理回應加上它要求的工具呼叫。
  - run 是從使用者輸入到最後回答之間的所有 turn。
  - run 進行中，那個對話就是忙碌狀態。
- app 被系統殺掉後重開，`harness.resume()` 會接著跑。中斷的工具呼叫怎麼處理，看它的 `replay`（下一節）。

## 工具

**`replay`：中斷後要不要重跑**（spec §7.3）
- 沒寫就是 `unsafe`：中斷的呼叫不重跑，回給模型 `interrupted`。`safe` 的會重跑。
- replay-safe 的工具如果有外部副作用，仍然要自己做到冪等。
- **我們的狀況**：
  - 只有天氣、地點、裝置、日曆讀取、`read_screen` 標了 `safe`。很多唯讀工具（通知、聯絡人、相片、通話、健康、`web_search`）沒標，app 被殺時會變成 `interrupted`，而不是自動重跑。
  - MCP 工具依 `readOnlyHint` 決定 `safe`（`src/agent/mcp.ts:344`）。但 MCP 規格要 client 把 annotations 當成**不可信**（見 [mcp-2026-07-28.md](mcp-2026-07-28.md)）：一個把寫入標成唯讀的 server，它的寫入會在重開後被重跑一次。

**平行執行**（spec §7.3、§8.3）
- 設定的 `toolExecution` 預設是 `parallel`：同一輪的工具呼叫全部同時開始。
- 只要其中一個工具標了 `executionMode: "sequential"`，**整輪**都會改成依序執行。
- 我們沒有任何工具標 sequential（和 `docs/tools.md` 2026-10-22 的量測一致）。

**需要時載入**（spec §7.3）
- `deferred` 的工具在載入前不會提供給模型。`tool_search` 用 BM25 搜尋工具的名稱、描述和參數，再用 `control.addTools` 載入。
- 載入的工具附加在其他工具後面，所以提示快取的前段不會被破壞；載入的狀態跟著對話分支走。
- codemode 的提示不列出 deferred 工具，腳本要用 `searchTools()` 找。
- 我們的「電腦畫面」、GitHub、雲端、MCP 都是這樣載入。實測模型會自己用 `tool_search` 載入（`docs/tools.md`）。

**工具只能透過 `api.env` 碰檔案和程序**，不能用建立工具時抓住的環境（spec §7.3）。我們的 `PhoneEnv`、`HostSandbox` 都是經由 `HarnessOptions.env` 依對話提供，符合這條規則。

**巢狀呼叫**：`api.executeTool()` 讓一個工具呼叫另一個（codemode、MCP bridge 都是這樣）。結果不會進入對話紀錄。

## 壓縮

- 用摘要取代舊的前段，原始紀錄仍留在儲存裡（spec §8.7）。
- 有三種觸發：
  - 手動。
  - 超過背景門檻：在背景壓縮，不阻擋生成。
  - 超過阻擋門檻或 context 溢出：生成會等壓縮完。
- 我們用 `withCompaction(provider, compactAt)` 設門檻（`src/agent/runtime.ts:358`），對應設定裡的 `compactAt`。

## pi-env daemon

**協定**（`packages/env/docs/protocol.md`）
- client 啟動 `pi-env serve --token <hex>`，用 stdin／stdout 通訊；stderr 只是 log。
- daemon 輸出的第一行是 `PI-ENV <token>`，之前的內容（例如 shell 啟動檔印出的東西）會被丟掉。
- **雙方每 5 秒 ping 一次**。daemon 30 秒沒收到任何資料，或 stdin 結束時，**會殺掉它開過的所有程序群組並結束**。所以連線斷了，遠端的指令就會停。
- client 在連線斷掉時，讓進行中的請求失敗（`lost: true`），下一個請求再啟動一個新的 daemon。

**指令怎麼跑**（`semantics.md`）
- 字串指令用 `/bin/bash -c` 執行（找不到就依序試 `which bash`、`sh`）。
- **每個指令都是一個新的 session（程序群組）**。逾時、中止和 `cleanup()` 都用 SIGKILL 殺掉整個群組。
- 程序結束後，最多再等 100 ms 收輸出；子孫程序還佔著 pipe 也會被關掉。
- 被訊號殺掉的回報 `128 + signal`。

**跟我們的關係**
- **斷線的處理 pi-env 自己就做了**：Bot 用 bash 開在背景的伺服器，會在手機斷線時被 daemon 殺掉。`pi-mobile serve` 為 `/env` 加的程序群組處理（`ffe41fb`）多一層保險，但主要靠 daemon。
  - `/exec`（MCP、容器引擎、bridge）不經過 pi-env，所以那邊的修正才是必要的：之前留下 7 個 computer-use-mcp 就是在這條路上。
- **pi-env 其實有終端機（PTY）**：`openTerminal(connection, options)` 可以在 daemon 的 pseudo-terminal 跑程式，例如使用者的 login shell（`packages/env/README.md`）。`docs/security.md` 寫「沒有互動式終端機，vim、REPL 不能用」，指的是我們沒有接上這個功能，不是 pi-env 做不到。

## pi-ai

- **中止**：`signal` 中止串流後，結果的 `stopReason` 是 `aborted`，已經收到的部分內容和 usage 都還在，可以放回對話繼續（README § Aborting Requests、§ Continuing After Abort）。
- **自訂 provider 和 fetch**：我們包了 `streamFetch`（`src/agent/stream-fetch.ts`），讓 ChatGPT 訂閱登入的串流走原生 HTTP（`src/agent/chatgpt.ts:148–149`）；MCP 的 HTTP 也用原生 fetch（`nativeFetch`），因為 WebView 的 fetch 會被 CORS 擋。
- pi-ai 支援 image generation、classification 等功能（README 目錄），我們目前沒有用。

## 我們有沒有逆著用

| 地方 | 狀況 | 建議 |
|---|---|---|
| 唯讀工具的 `replay` | 多數沒標 `safe`，app 被殺後不會自動重跑 | 把純讀取的工具都標 `safe` |
| MCP 的 `replay` 靠 `readOnlyHint` | annotations 依規格不可信 | 對 MCP 工具一律 `unsafe`，除非是我們自己的 server |
| 電腦上的長期 MCP 連線 | 一台電腦一個 stdio 程序，跨 Bot 共用 | 符合 MCP 的無狀態要求，但 session 要用 handle（見 MCP 那份） |
| 背景程序的生命週期 | pi-env 斷線就殺 | 已經是期望的行為；Bot 要長期跑的服務需要別的機制（例如 launchd），目前沒有 |
| 終端機 | 沒接 `openTerminal` | 之後要做互動式終端機時直接用它，不必自己做 |

## 對 pi-mobile 的結論

1. **純讀取的工具都標 `replay: "safe"`**，app 被系統殺掉後就能自動重跑。
2. **MCP 工具不要靠 `readOnlyHint` 決定能不能重跑**：外部 server 一律 `unsafe`。
3. **不要讓任何工具標 `sequential`**：一個就會讓整輪變成依序，抵銷平行執行的效果。
4. **背景程序會在斷線時被 pi-env 殺掉**：這是設計，不是 bug。要長期跑的服務，之後再另外設計。
5. **要做終端機時用 pi-env 的 `openTerminal`**，並更新 `docs/security.md` 那一行的說法。
