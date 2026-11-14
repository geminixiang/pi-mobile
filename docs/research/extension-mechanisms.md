# Extension 機制研究：pi-coding-agent 與 pi-durable 1.5.0

2026-11-09。上游機制研究。工具組偏好後來的做法（`Bot.off` 存工具組 id）見 `docs/design/toolset-preferences.md`；§6 記的是研究當時對舊推薦的修訂方向。

證據標記：**實跑**表示對真套件執行；**讀碼**表示由指定版本的實作或官方文件確認；**待驗**表示不在本次證據範圍。沒有修改產品程式。

## 1. 先固定版本，不混用同名 API

- pi-mobile 使用 `@earendil-works/pi-durable@1.5.0`。
- 本機 Pi 使用 `@earendil-works/pi-coding-agent@1.5.0`。
- 上游來源：[`earendil-works/pi` 的 f9a26365568127461c47a07a37dcb42c140a3ac5](https://github.com/earendil-works/pi/tree/f9a26365568127461c47a07a37dcb42c140a3ac5)，Release v1.5.0。
- **實跑版本比對**：durable 安裝檔 source maps 的 96 個原始檔與該 commit 全部相同（Claude）；coding-agent 的 253 個原始檔全部相同（pi）。
- 較舊的 pi checkout 不能直接拿其測試或範例的 API 當成 1.5.0 契約。實際遇到舊範例的 `AuthStorage` 已不在目前 exports 的差異，探針已改用 `CredentialStore`。

下文的原始碼路徑都相對該上游 commit。套件目前安裝位置與實跑命令在文末。

## 2. 同叫 extension，但抽象不同

| 面向 | pi-coding-agent | pi-durable |
|---|---|---|
| 主要宿主 | Node/Bun 的 agent session、CLI／SDK | 宿主提供儲存與執行環境的 durable Harness |
| 擴充定義 | factory 收到 `ExtensionAPI`，註冊工具、事件、命令等 | 具名資料包：tools、sections、hooks、wraps、tasks |
| 載入 | ResourceLoader、檔案／套件／inline factories、project trust | host 自己建立 registry 並 install |
| 作用範圍 | session extension runtime | registry 為 Harness 共用；每個 conversation 選擇擴充 |
| 動態更新 | registerTool／setActiveTools；reload 重建 runtime | 同名 install 原地替換；每個 phase 取 registry snapshot |
| 狀態 | session entry tree、tool result details、custom entries | typed documents、原子 commit、document migration／fork semantics |
| MCP | 內建 extension＋server registry | 沒有原生 MCP server 概念；pi-mobile 自己轉成 extension |

**讀碼**：coding-agent `docs/extensions.md`、`docs/sdk.md`、`src/core/extensions/{loader,runner,wrapper}.ts`；durable `README.md`、`docs/spec.md` §7.1–7.5。

不能把 coding-agent 的 `setActiveTools`、`prepareLoadout` 或 TUI extension 原封不動搬到 durable／WebView。

## 3. pi-coding-agent 有哪些可用特性

### 註冊、active、callable、模型宣告是不同集合

**讀碼＋實跑**：`packages/coding-agent/src/core/agent-session.ts` 的 `_getCallableTools`、`_applyToolLoadout`、`_refreshToolRegistry`。

| exposure | 模型直接呼叫 | 其他工具／codemode 呼叫 |
|---|---|---|
| direct | active 時提供 | active 時可呼叫 |
| model-only | active 時提供 | 不可呼叫 |
| codemode | 明確激活才提供 | 註冊後即可呼叫，不必 active |
| deferred | tool_search 或明確激活後提供 | 註冊後即可呼叫，不必 active |
| hidden | 不提供，不能激活 | 不可呼叫 |

實際 `setActiveTools([])` 後，codemode/deferred 仍在 callable 集合。因此這個 API 不是「全面關閉某能力」的權限開關。

`prepareLoadout` 可以改模型宣告的 description、隱藏 declarations。**實跑**：request 已不含 direct 工具宣告，但 active/callable 仍含該工具。隱藏提示不等於阻擋執行。

### 動態載入與組合

- **讀碼＋實跑**：`registerTool` 可在 session_start 或之後註冊，立刻刷新工具 registry；direct/model-only 通常自動激活，`defaultActive:false` 除外。
- **讀碼＋實跑**：沒有 `unregisterTool`；同名重註冊為 hidden 能撤回可達性。
- **讀碼**：namespace、aliases、instructions 支援 codemode 列舉與按需說明；`reachesTools` 讓 MCP 等延遲載入器知道一次呼叫可能用到什麼。它們不是使用者偏好或權限模型。
- **讀碼**：replaceable extension、來源資訊、package discovery、project trust 是宿主載入政策，不是每個 Bot 的能力組合規則。
- **實跑**：SDK 的 `tools: []` 是空 allowlist；`noTools: "builtin"` 只改初始選擇，不能把兩者混用。

### 事件與提示掛點

**讀碼**：`docs/extensions.md` Events／Handler Composition；`src/core/extensions/runner.ts`。

- `before_agent_start.systemPromptOptions` 可改結構化 sections／selectedTools；選擇變動會影響可執行的模型工具，而非只有說明文字。
- `context` 只改非 system 訊息，Pi 會恢復 prompt/tool state；`context_with_system` 可改完整 request，但不因此重設 runtime 可呼叫工具。
- `tool_call` 可阻擋／改參數；執行層不是只信模型看到的提示。`tool_result` 可鏈式改結果。
- **實跑**：完整 faux provider 回合中的 nested call 也走 tool_call gate，帶 parentToolCallId。hidden／model-only nested call 被拒絕；未知工具不先進正常 tool_call handler。
- `turn_end`、`agent_before_settle` 能要求 continuation；`agent_end` 不代表最終閒置，`agent_settled` 才是。不要把通知、轉換、gate 與 continuation 都當成同一種事件。
- providers／virtual models／MCP／UI renderers／命令與快捷鍵也是擴充能力；UI 又分 TUI、RPC、print，`hasUI` 不保證能跑 terminal component。

### Session 生命週期與持久化

**讀碼＋部分實跑**：`agent-session.ts` 的 `_restoreToolsFromTranscript`、`reload`；`docs/extensions.md` State Management／Session replacement。

- custom entries 不進模型 context；extension 應以 active branch 還原狀態，不能把所有分支 entry 混成一個狀態。
- AgentSession 從分支的 system tool deltas 還原 active loadout；晚註冊工具可先記 pending。這不是穩定產品工具組偏好。
- new／resume／fork／reload 會重建 extension runtime；tree navigation 不重建，需另處理 session_tree。
- **實跑**：reload 後舊 API stale。低階 SDK `bindExtensions({})` 之後 reload 不重發 session_start；有 onError 等 binding 才通過 hasBindings 分支。這是 1.5.0 整合細節，不宜只依文件的概括敘述。

## 4. pi-durable 的選擇和擴充組合

### 原生的解析管線

**讀碼**：`packages/durable/src/harness/agent.ts`；`docs/spec.md` §7.1。

1. `settings.extensions`（未指定則所有安裝擴充）為基底。
2. conversation 的 `AgentDoc.extensions` 可指定完整陣列，或 add/remove 差量。
3. 被選擴充的同名工具／section，後者勝出；wraps 包裝勝出者。
4. `AgentDoc.tools` 再篩選已啟用工具，會影響模型和腳本兩邊。
5. `callers` 決定 model／tools 能否呼叫；`modelTools` 只縮小模型端。
6. sections 與 hooks 跟著擴充選擇，不會因為 `tools.remove` 就自動全部消失。

**實跑**：同名工具在兩擴充中，只選手機版就用手機版、只選電腦版就用電腦版、兩者都選時後者勝出。

但不能把擴充任意複製成兩份：**實跑**兩份 hook 都會執行；同 key section 只剩後者；同名 task 在安裝時就被拒絕。pi-mobile 工具快照又以工具名為鍵，同名工具方案會要求修改檢查。這是替代方案的真實成本。

### 動態 registry 是原生能力，但不是 per-conversation selector

- **讀碼＋實跑**：registry install 同名替換並保留位置；uninstall 後名稱可留在 AgentDoc，重新安裝會恢復解析。registry 本身不持久化。
- **讀碼＋實跑**：settings getter 是動態的，變動會影響使用預設的對話；但它不收 conversationId，是全域 defaults。
- **讀碼**：wraps 不收 conversation context；beforeRequest 可改 messages，沒有同時改變執行工具集合的 per-conversation 選擇掛點。
- **讀碼**：section render 有 conversationId、resolved agent、env、已提交文件的讀取介面；可以依 `agent.tools` 顯示說明，無須另存提示用工具清單。

所以在已檢查的 1.5.0 公開 API 中，依對話生效的擴充／工具選擇仍由 `pi.agent` 承擔。不能拿全域 getter 或 provider payload 改寫冒充執行層投影。

### control.addTools 與執行邊界

- **實跑**：工具結果的 `control.addTools` 會解除 `tools.remove`，並記入 modelTools。正常 tool_search 的候選已被 tools 篩選，但任意 loader 不一定遵守此限制。
- **實跑（sequential 模型工具呼叫）**：同輪先移除 victim，後續 victim 會被拒絕；同輪才加入的 late 工具仍不能呼叫，下一輪才可用。
- **實跑**：同輪移除 guard extension 後，下一工具不再跑其 beforeTool hook。
- **讀碼**：已開始執行的階段／工具持有自己的快照，不會被 retroactively 撤回。

不要把上述 sequential 證據擴張成「所有 parallel／nested 呼叫都只減不增」或「移除能撤銷已發生副作用」。產品授權也不應只靠模型隱藏或選擇名單。

## 5. 先前漏看的原生持久化能力

### 文件自己就有版本遷移

**讀碼＋實跑**：`defineDoc({ version, migrate })`；spec §3.6；`session-checkpoints-migrations` tests。

- migrate 收到持久化的 fromVersion，需自行涵蓋跳版；不是自動替你保存每個舊版本的函式。
- snapshot 唯讀遷移只發生在記憶體；`tx.doc` 才把新版本寫回。
- snapshotAsOf／fork 先取得歷史值，再按該值的版本遷移。
- 尚未存在的文件，transaction 外 snapshot 是 undefined；transaction 內 `tx.doc` 會套 initial，因此「空偏好」不能作為尚未匯入的證據。

對 App 自己的偏好文件，原生 version/migrate 可以取代自製的 STEPS＋MigrationDoc 進度。首次從別份 `AgentDoc` 匯入是另一件事，需在原子交易內明確區分未匯入與已匯入狀態。實作可用 discriminated union，不必照探針的 boolean 加空欄位。

### 公開 configure 可在同一筆交易使用

**實跑**：`configure(tx, conversationId, change)` 與 `tx.doc(Prefs)` 可以在同一筆提交中使用。不必自己重寫 AgentDoc 的 normalization。

更正先前說法：configure 裡的 names() 主要是 ref→string 轉換，不能概稱「驗證所有工具名字」。registry 也刻意容許暫時不存在的名稱留在設定裡。

### fork、子對話與建立掛點

**讀碼＋實跑**：AgentDoc 是 rewindable/asOf；task-owned 子對話複製 owner 的 agent；conversationCreated 在 create／task child／fork 的交易內呼叫。

若 App 偏好與 agent 應同時反映分支歷史：
- 偏好文件採 rewindable/asOf。
- 子對話透過 record.owner 複製偏好。
- fork 已複製歷史文件，看到 record.parent 不要重設。
- 新對話和既有缺文件的對話，需區分「新預設」與「匯入舊選擇」。

這些是原生整合點，不應只在 App 的 createBot 手動補一半。App 目前沒有暴露 fork，不代表設計時可以把資料歷史語意設錯。

## 6. 對既有規劃的影響

| 既有推薦 | 研究後處理 |
|---|---|
| 工具組 ID 保存產品偏好 | 仍有理由保留：上游沒有產品分組／跨版本使用者意圖模型 |
| 單一 reconcile 合併偏好與 workplace | 仍是可行候選；上游沒有帶 conversationId 的動態 selection getter |
| 額外 STEPS＋MigrationDoc | 對新 Prefs 文件應改用原生 version/migrate；首次 legacy 匯入另外原子處理 |
| 直接改 AgentDoc | 改用公開 configure(tx, …) |
| 只在 createBot 初始化 | 改以 conversationCreated 覆蓋所有建立入口 |
| 沒有指定偏好文件歷史政策 | 明確採與 AgentDoc 一致的 rewindable/asOf，並處理 child |
| 欄位不存在就自動代表全開 | 不足；須區分新對話預設、舊資料待匯入、已保存空偏好 |
| 共用擴充只能靠新偏好模型解決 | 不精確；原生同名工具＋不同擴充也能解部分問題，但 hook/task/快照與地點成本更高 |

這些是研究後的修訂方向，**不是新架構已被整合驗證**。完整 reconcile 的 MCP 動態生命週期、初次 frozen legacy mapping、錯誤恢復與快取，仍需 app contracts。研究前那份「定稿推薦」不能直接作為實作契約。

## 7. 驗證紀錄與邊界

### 自己寫的探針

- coding-agent：真 SDK＋安裝版 faux provider 的完整回合；assertions 驗證動態註冊、active/callable、hidden、request declarations、nested guard、reload stale API。pi 執行通過。
- durable E1–E7：全域 defaults、同名工具、fork、conversationCreated、同回合移除、registry 重裝、addTools。Claude 執行，pi 已獨立重跑輸出一致。
- durable P1／P2／P4／P5：子對話、版本遷移、歷史 snapshot、匯入標記、hook 選擇、同輪新工具、重複 hooks/tasks。Claude 執行，pi 已獨立重跑輸出一致。durable 探針以列印觀察為主，不冒稱全部是自動 assertion suite。

### 同版本上游測試

Claude 執行：
- registry／callers／tool-search／fork／tool-hooks／hook-reads：6 檔，55 tests 通過。
- 包含 migrate／conversationCreated 的相關測試：12 檔，274 tests 通過。

pi 獨立執行 durable 的 registry／callers／tool-search／fork／tool-hooks／hook-reads／checkpoints-migrations／conversations：8 檔、87 tests 通過。上述集合有重疊，不相加當成不重複測試數。Claude 執行 coding-agent 同版本 dynamic-tools／runtime-events／extensions-runner／nested-tool-calls／tool-search／tool-system-prompt-contributions：6 檔、112 tests 通過，沒有略過。測試以原始碼執行，依賴的 workspace 套件先離線建置；沒有跑 coding-agent bundle build。

### 未涵蓋

- 不是上游全部 suite，也沒有測所有 provider／平台。
- durable store／workers 專用設定未跑；afterRun／onYield／compaction 的全部選擇交互作用沒有逐一實驗。
- 沒有宣稱 parallel／nested 動態撤回全部情境安全。
- 沒有上手機，沒有新架構效能數據。
- 沒有完成新 reconcile 與 MCP 的 app 整合測試。

## 8. 重跑

探針是一次性研究腳本，不在 repo 裡。重跑時：

- 取上游 `earendil-works/pi` 的 f9a2636，跑 §7 列的同名測試檔。
- coding-agent 探針：以 SDK 加 faux provider 跑完整回合，不用真模型。
- durable 探針：從 `node_modules/@earendil-works/pi-durable` 匯入，依 §4、§5 每一條「實跑」各寫一個情境。

## 對未來的影響

研究把 app 自己要擁有的「產品偏好與環境政策」和上游已提供的「工具執行、擴充選擇、原子交易、版本遷移與分支歷史」分開。應刪除重複的持久化機制，而不是再包一層通用 extension framework。整合實作前仍需修訂設計與驗證清單。本輪針對工具組／環境整合所需的核心機制完成研究；不宣稱讀完所有上游功能或測遍所有執行交錯。
