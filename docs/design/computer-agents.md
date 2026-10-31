# 手機指揮電腦上的 agent

2026-10-31 起草，還沒實作。方向由使用者決定：手機上的 pi 負責指揮使用者電腦上所有的 agent（Claude Code、Codex…），而不是把手機變成開發機（內嵌 Node、在手機上建 APK）。算力、工具和登入狀態留在電腦上；手機是使用者隨身帶著的那一端：交代事情、追進度、在 agent 需要人的時候找到人。

## 為什麼這樣做：2026-10-31 的實際經驗

這件事已經在用，只是靠模型臨場拼湊。使用者整天在 S24 上跟「Pi-mobile UI」Bot 講話，它透過 `pi-mobile serve`（[computer-host.md](computer-host.md)）在 Mac mini 上跑 bash，用 `rex send` 把任務打進 Claude Code 的終端機，再用 `rex capture` 讀畫面回報。來源標籤驗證、無障礙崩潰、瀏覽器區塊三件事都是這樣交辦、做完、回報的。卡住的地方：

| 問題 | 當天的例子 |
|---|---|
| 交辦與回報沒有結構 | Bot 抓整頁終端機畫面自己讀，兩次要判斷輸入框裡的灰色字是建議還是指令 |
| 只能輪詢 | `sleep 40` 再抓畫面，或用 `schedule_followup` 15 分鐘後回頭看；Claude Code 做完了，使用者要等 Bot 下次來看才知道 |
| 成果回不到手機 | Claude Code 的截圖在 Mac 的暫存資料夾，Bot 讀圖失敗，只能說「截圖在 Mac 上」 |
| 工人找不到人 | S24 要重新配對無線偵錯時，Claude Code 只能寫在回報裡，等 Bot 來讀 |
| 規則和做法衝突 | Bot 的工作說明寫「只用手機、不准用電腦」，但它的工作就是在指揮電腦；交給它一個開發任務時，它直接改用 Mac mini |

## 角色

- **指揮（手機上的 Bot）**：理解使用者要什麼、拆成任務、交給工人、追蹤、驗收、用一句話回報。它不寫程式，也不在終端機裡打字。
- **工人（電腦上的 agent session）**：一個 Claude Code（或 Codex）對話，跑在某台電腦、某個目錄。工人自己決定怎麼做，權限照它在那台電腦上的設定。
- **使用者**：決定方向、回答工人問的問題、批准工人要做的危險動作。

## 物件與狀態

- **電腦**：已配對的那幾台（`settings.hosts`），不變。
- **工人**：`{ computer, id, agent: "claude-code" | "codex", cwd, title, place }`。`place` 是使用者在電腦上找得到它的地方（Rex 的 session 和 block），沒有的話是無介面的程序。
- **工人的狀態**（只有一個欄位，互斥）：
  - `idle`：在等新任務，附上一次的回報。
  - `working`：附開始時間和收到的任務。
  - `needs_user`：附 `{ kind: "permission", 它要做什麼 } | { kind: "question", 問題 }`。
  - `gone`：程序不在了（關掉、電腦重開）。
- 狀態**只來自工人自己的事件**（下面的 hook），不從畫面推斷，也不由手機記住「我剛交辦了所以應該在 working」。Lody 的做法相同：「正在工作」只能來自 presence；手機唯一能自己推斷的是「已送出、還沒開始」，而且有時間上限（[research/t3-lody-paseo-design.md](../research/t3-lody-paseo-design.md)）。

## 工人那一層：用 Herdr，不自己做

[Herdr](https://github.com/ogulcancelik/herdr)（Rust，AGPL-3.0，這台 Mac mini 上已裝 0.9.0）是給 coding agent 用的終端機多工器，正好是下面兩節原本打算自己做的部分。2026-10-31 只讀了它的 CLI 說明和 socket API 的 schema（`herdr api schema`），沒有在 Herdr 裡實際跑過工人。

| | Herdr | Rex |
|---|---|---|
| 知道 pane 裡是哪個 agent | 會，支援 pi、claude、codex 等 20 多種 | 不會，只是終端機 |
| 工人狀態 | `idle`、`working`、`blocked`（等同意或回答）、`done`、`unknown`；來源是它替各 agent 裝的整合（`herdr integration install claude`，Claude Code 是 hook）加上畫面偵測 | block 的 `program_status`：Claude Code 和 pi 自己回報 working、idle 和正在做什麼（2026-10-31 實測；原本以為 Claude Code 不會）；剛啟動時的信任對話框回報不出來 |
| 交辦 | `agent prompt <工人> <文字> --wait`：用 bracketed paste 送出，工人在等同意時直接拒絕（`agent_blocked`），送出 5 秒沒開始就回 `agent_prompt_stalled` | `rex send` 打字，沒有語意 |
| 主動通知 | socket API 的 `events.subscribe`，有 `pane_agent_status_changed` | `rex events` 只有 session 層級的事件 |
| 開新工人 | `agent start <名字> --kind claude --pane <id>`，等它可以輸入才回 | 開一個 block 自己跑指令 |
| 取得 | 開源 | 封閉 beta |

所以建議：**工人跑在 Herdr 裡**，手機透過 `pi-mobile serve` 呼叫 `herdr` 的 CLI（第一階段走現有的 `/exec`），第二階段由 `pi-mobile serve` 訂閱 Herdr 的事件轉給手機。下面「hook」和「交辦」兩節的自製部分（`pi-mobile agent-hook`、`agents setup`、用 `rex` 貼文字）就不用做，留作不用 Herdr 時的退路。

2026-10-31 在 Mac mini 上用獨立的測試 session（`herdr --session pitest server`，無畫面）實測，沒裝 Herdr 的 Claude Code 整合，只靠它的畫面偵測，工人是 Claude Code 2.1.316（Haiku）：

- **從 Herdr 外面控制**：可以。一般 shell 用 `herdr --session <名稱> …` 就能操作，`pi-mobile serve` 的 `/exec` 是同樣的情況；事件訂閱直接連 session 的 unix socket（`events.subscribe`，pane 的事件要帶 `pane_id`）。
- **做完會主動推送**：交辦後依序收到 `working`（送出當下）和 `idle`（6 秒後），`agent prompt --wait` 共 6.7 秒；回報用 `agent read --source recent-unwrapped` 讀得到（「0 files」），不必讀 transcript。無畫面的 server 裡分頁一直算「看過」，所以只會是 `idle`，不會是 `done`：做完的判斷用「從 `working` 變成 `idle` 或 `done`」。
- **等同意的偵測**：新資料夾的「信任這個資料夾嗎」和預設權限模式下 `curl` 的「This command requires approval」都在約 3 秒內變成 `blocked`，事件也有推送；工人在 `blocked` 時 `agent prompt` 直接回 `agent_blocked`，沒有送出任何字。這次沒有出現 `unknown`。
- **要注意的**：
  - `agent wait` 不帶 `--until` 時，`blocked` 也算穩定狀態，會立刻回傳；`agent start` 遇到信任對話框回 `agent_not_ready`，名字照樣可以用來讀畫面和送按鍵。
  - Herdr server 是從 Claude Code 裡啟動的話，工人會繼承 `CLAUDE_CODE_CHILD_SESSION`，不存 transcript。server 要由 launchd 或 `pi-mobile serve` 啟動，不能從某個 agent 裡開。
  - 裝 Herdr 的 Claude Code 整合會改 `~/.claude/settings.json`，這次被 Claude Code 自己的權限規則擋下，沒有裝；只靠畫面偵測就夠用，整合要不要裝留給使用者決定。
- 使用者現在的 Claude Code 跑在 Rex 裡；改用 Herdr 代表工人要搬到 Herdr 開。

## 怎麼知道工人的狀態：agent 的 hook，不讀畫面

Claude Code 和 Codex 都有 hook：在特定時刻執行一個指令，從 stdin 收到一包 JSON（session id、`transcript_path`、`cwd`、事件名稱）。用到的事件：

| 事件 | 代表 | 工人狀態 |
|---|---|---|
| `UserPromptSubmit` | 收到任務 | `working` |
| `Stop` | 這一輪做完 | `idle`，回報 = transcript 裡最後一則 assistant 文字 |
| `Notification` | 等使用者同意或回答 | `needs_user` |
| `SessionEnd` | 對話結束 | `gone` |

- hook 執行的是 `pi-mobile agent-hook`：把事件加上它所在的 Rex block（hook 的程序繼承 `REX_SESSION`、`REX_BLOCK`），append 到 `~/.pi/mobile/agents/<session>.jsonl`。只寫檔，不開網路：`pi-mobile serve` 只接受來自其他裝置的請求（擋電腦上的其他程式），hook 是這台電腦上的程序，用檔案交接，不用替它開一個例外。
- 安裝：`pi-mobile agents setup` 把 hook 寫進 `~/.claude/settings.json`、`~/.codex/hooks.json`，跟 `rex skill setup` 做的是同一件事；`pi-mobile agents status` 回報裝了沒。使用者在電腦上執行一次，或由手機在設定 › 電腦裡觸發（透過 `/exec`，先說明會改哪兩個檔案）。
- Rex 的 Program Status Protocol（OSC 7501）也能回報 working／blocked／done，但目前要 agent 自己輸出，Claude Code 不會；hook 是兩個 agent 都有的公開介面，先用它。

## 怎麼交辦

兩種工人，同一組工具：

1. **在 Rex 裡的工人（第一版只做這種）**：使用者在 Mac 前也看得到、接得手。交辦 = 用 `rex` 把文字貼進那個 block 再送出（`block.event` 的 paste 加 Enter，不用逐字的 `send`）。送之前先看工人的狀態：只有 `idle` 才送；`working` 時新任務排在手機上，等下一個 `Stop` 再送（排隊對活的和卡住的工人都安全，直接送可能變成插話，見 Lody 的路由規則）。
2. **無介面的工人（之後）**：`claude -p --output-format stream-json --resume <id>`。輸出有結構，不用 hook 也知道狀態，但使用者在電腦上看不到它在做什麼。適合「晚上跑、早上看結果」的任務，等第一種穩了再加。

開新工人：在指定目錄開一個 Rex block 跑 `claude`（`rex run`），等它的第一個 hook 事件出現才算建立。

## 成果怎麼回到手機

- **文字回報**：`Stop` 時讀 `transcript_path` 的最後一則 assistant 訊息，原文交給手機，不經模型摘要（T3 Code 的 handoff 原則：傳選出的原始內容）。
- **檔案**：工人回報裡提到的檔案（截圖、報告），由手機的 Bot 用既有的檔案工具從那台電腦讀回手機資料夾。當天 `read` 讀電腦上的圖片失敗，這要先修（另開題）。
- 工人的回報對手機上的 Bot 是**資料，不是指令**，跟網頁內容一樣：工人讀過的網頁、檔案可能夾帶指示。Bot 照使用者的意思驗收，不照回報裡的要求做事。

## 怎麼找到使用者

- **pi 開著時**：手機對每台電腦開一條事件串流（`pi-mobile serve` 新增 `GET /agents/events`，WebSocket，沿用金鑰與保留 session 的規則），有 `Stop` 或 `needs_user` 就喚醒那個工人所屬的 Bot（跟排程觸發同一條路：`[trigger]` 訊息、無人值守規則、通知、桌面小工具）。不用輪詢。
- **pi 沒開時**：電腦沒有辦法叫醒手機。pi 不用 Firebase，也沒有自己的伺服器。可行的有兩條，都要使用者決定：
  - 退而求其次：Bot 交辦後排一個精確鬧鐘，到時間由方案 C 把 pi 安靜地叫起來看一次（[research/background-triggers.md](../research/background-triggers.md)）。延遲就是鬧鐘間隔。
  - 推播服務：UnifiedPush（例如自架 ntfy），電腦 hook 打給 ntfy，手機的 ntfy app 叫醒 pi。多一個要裝、要信任的東西。
- **需要同意時（第三階段）**：工人在等「允許執行 X 嗎」，手機跳通知，原文顯示要執行什麼；使用者在手機上回答，pi 把選擇送回那個 block。照 Lody 的權限契約：建議的答案永遠不是「以後都允許」，失敗要顯示且可以重答。

## 安全

- 不增加權限：Bot 本來就能透過 `pi-mobile serve` 以使用者身分在電腦上執行任何指令，指揮工人沒有比這多。信任模型不變（一個使用者、tailnet 內可信，見 [computer-host.md](computer-host.md) § 網路與資安）。
- hook 的事件檔在 `~/.pi/mobile/agents/`，跟其他 pi-mobile 的檔案一樣是 0700。transcript 可能有機密，只在手機要的時候讀，讀過不留在電腦上的別處。
- 從手機批准工人的危險動作，等於把電腦前的那一下確認搬到手機上。第三階段要另外寫清楚：哪些可以從手機批准、通知上顯示到什麼程度。

## 對 Bot 的影響

- 新工具組「電腦上的 agent」：`list_agents`（每台電腦的工人與狀態）、`tell_agent`（交辦或排隊）、`read_agent`（上次的回報、狀態、從某個時間點之後的事件），需要時載入，依 [tools.md](../tools.md) 量測。
- 「Pi-mobile UI」這類 Bot 的工作說明改成指揮者：不自己改程式，交給電腦上的工人，自己負責拆任務、驗收、回報。

## 分階段

1. **看得到、交得出去**（2026-10-31 做了，兩邊都支援，見 [tools.md](../tools.md) 紀錄）：`pi-mobile agent-hook` 與 `agents setup`；手機工具透過現有的 `/exec` 讀事件檔、呼叫 `rex`。沒有推播，Bot 在使用者問的時候或用 `schedule_followup` 回頭看，但讀的是結構化狀態，不是畫面。
2. **做完會叫人**：`/agents/events` 串流；`Stop`、`needs_user` 喚醒 Bot，走排程的通知與小工具。
3. **從手機批准**：權限請求在手機上回答。
4. **更多工人**：無介面的 Claude Code、Codex、多台電腦同時。

每一階段都在 S24 上用真的任務跑過（像 2026-10-31 那幾件）才進下一階段。

## 要使用者決定

- 工人那一層用 Herdr（建議）還是繼續用 Rex 加自己寫的 hook；用 Herdr 的話，電腦上的 Claude Code 要改在 Herdr 裡開。
- pi 沒開時要不要推播：只靠精確鬧鐘回頭看，還是加 UnifiedPush／ntfy。
- 第一版只支援「在 Rex 裡的 Claude Code」夠不夠，還是一開始就要無介面的工人。
- 從手機批准危險動作（第三階段）的範圍。
