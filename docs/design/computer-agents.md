# 手機指揮電腦上的 agent

2026-10-31 起草，部分已實作（`src/computer-agents/`），下面第 2、3 項註明了做到哪裡。方向由使用者決定：手機上的 pi 負責指揮使用者電腦上所有的 agent（Claude Code、Codex…），而不是把手機變成開發機（內嵌 Node、在手機上建 APK）。算力、工具和登入狀態留在電腦上；手機是使用者隨身帶著的那一端：交代事情、追進度、在 agent 需要人的時候找到人。

## 為什麼這樣做

方向由使用者決定：手機上的 pi 指揮電腦上既有的 coding agent（Claude Code、Codex、pi），不把手機變成開發機。2026-10-31 臨場用 `bash` + `rex send/capture` 跑真實任務暴露四個痛點：無結構狀態（分不清輸入框灰色建議與指令）、只能靠 `sleep`/follow-up 輪詢、成果檔回不到手機、工人卡在批准時找不到人。因此獨立成一組工具（`src/computer-agents/`）。

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
- 狀態**只來自工人自己的事件**（下面的 hook），不從畫面推斷，也不由手機記住「我剛交辦了所以應該在 working」。Lody 的做法相同：「正在工作」只能來自 presence；手機唯一能自己推斷的是「已送出、還沒開始」，而且有時間上限（[research/references.md](../research/references.md)）。

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

## 設計取捨與現況

- **直接呼叫 Herdr（含 Windows `hc`）與 Rex CLI，不做自寫 hook**：原本評估過自寫 `pi-mobile agent-hook` 掛進 `~/.claude/settings.json` 與 `~/.codex/hooks.json`，但 Herdr 已內建狀態追蹤與 `agent prompt`，Rex 也有 `program_status`（OSC 7501），直接透過現有 `/exec`（走 held session）讀寫即可，不改使用者的 agent 設定檔。
- **交辦原則**：只對 `idle` 的工人交辦；`working`/`blocked`/`unknown` 時拒絕（防插話或誤送）。工人回報對手機 Bot 一律視為**不可信資料**（經 `guard.ts` 與 `outside.ts` 防線，見 [outside-content.md](outside-content.md) 與 [research/manager-eval.md](../research/manager-eval.md)）。
- **找到使用者（目前做法與缺口）**：`tell_agent`／`answer_agent` 建立精確鬧鐘 `watch`（不叫模型先查狀態，1/3/10 分鐘遞增，閒下來或等使用者才叫醒 Bot）；`answer_agent` 經對話由使用者回覆再轉按選項（排程無人值守回合一律拒絕）。
- **安全**：不增加比 `/exec` 更高的權限；不從手機直接一鍵「以後都允許」（需使用者明講並帶 `stop_asking`）。

## 一個 Bot 指揮每台電腦上的 agent

2026-11-25 起，`list_agents` 列出每台配對電腦上的 agent，不只 Bot 工作的那台：使用者在 Mac mini 和 MacBook Air 之間切換，只說「跟 pi-linux 拆鎖那個說先停」，不說在哪台。之前看不到另一台時，Bot 自己 ssh 過去，花了 144 秒、20 次工具呼叫。

- **id 帶電腦**：`<電腦>/<id>`，電腦是配對時 Tailscale 名稱的第一段（`geminixiangmac-mini`），穩定、使用者看得懂。代價是 id 有兩種寫法：不帶電腦的舊 id 仍指 Bot 自己的電腦，存著的 watch 不用遷移；新的輸出一律帶電腦，watch 也存帶電腦的那種，所以之後 Bot 換了電腦，watch 還是看原來那台。兩種寫法只在 `reach.ts` 的 `parseAgentId` 分辨：`/` 前面沒有 `:` 才算電腦，所以 `hc:office/t7` 這種本來就有 `/` 的 id 還是舊寫法。用 IP 配對的電腦名字會是 IP 的第一段，可能撞名；配對時有 Tailscale 名稱就用名稱，所以只是理論上的情況。
- **每台各等約 4 秒**：同時問，沒回或連不上的電腦只佔一行（「… did not answer」），不讓整個呼叫失敗。代價是有一台沒開時，列表固定多等 4 秒；不等的話，剛醒的電腦會被當成不在。
- **只有 agent 跨電腦**：Bot 自己的 `bash`、檔案和資料夾仍在面板選的那台。
- **少一點雜訊**：背景指令只列執行中和結束一小時內的（指令資料夾還是留一天）；Rex agent 的名字先用使用者取的視窗標籤（`rex window ls`），預設標籤（以視窗 id 結尾）不算，沒有才用 session 標籤。
- **提示**：說明 agent 只透過這組工具找，不用 ssh；兩個 agent 都符合使用者說的時，用 `ask_user` 問，不猜也不兩個都答。

## 還沒做／待決定

1. **`GET /agents/events` 事件串流**：目前靠鬧鐘 `watch` 輪詢；改成 `pi-mobile serve` 訂閱 Herdr／Rex 事件主動推送後，可即時喚醒 Bot 並供工作台名冊使用。
2. **pi 沒開時的推播**：目前靠精確鬧鐘＋安靜啟動；若要即時通知，需決定是否導入 UnifiedPush（ntfy）。
3. **無介面工人**（`claude -p --output-format stream-json --resume`）與通知上直接帶批准按鈕。
