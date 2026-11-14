# Agent 工作後台：市場調查與 pi mobile 的資料（2026-11-15）

使用者要的第一個 iPad 工作台：像 IDE 一樣的工作後台，管理大量 agent，不管它在手機上還是在電腦裡（Herdr、Rex 管的那些），重點是管理、看進度、看工作內容。不是照抄 VSCode；市面上的還沒有讓使用者滿意的。

這份的來源：市場調查由 gpt-6-astra 做（讀各產品的文件，沒有實際試用，連結附在各項）；pi mobile 自己有什麼資料由 claude-fable-5-2 盤點（讀程式碼，引用 `file:line`），其中 `/agents/events` 事件串流「設計了但還沒做」這點我用 `grep` 對過。

## 市面上的做法（2026-11-15 的狀況）

| 產品 | 管理與狀態 | 看工作內容 | 人怎麼介入 | 跑在哪 | 缺點 |
|---|---|---|---|---|---|
| [Conductor](https://www.conductor.build/docs/reference/diff-viewer) | 側欄分開「需要你」和「CI 還在跑」 | diff、行內回饋、審查、CI | 回覆、iPhone 遠端控制 | 本機 workspace 或雲端沙箱 | iPhone 需要 Mac 醒著；不是任意終端機的總覽 |
| [Nimbalyst](https://nimbalyst.com/docs/session-management/agent-window-and-session-management/)（Crystal 的後繼） | **注意力**（等你、執行中、未讀）和**任務階段**（待辦、規劃、實作、驗證、完成）分兩條軸 | 卡片上即時預覽對話；改動進審查面板 | iOS 可以開始、接續、回答 | 桌機 | 手機上不能看 diff |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban/) | 看板四欄 | agent 活動、log、diff | 對話式行內回饋 | worktree、遠端伺服器 | 公司已[收掉](https://www.vibekanban.com/blog/shutdown) |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | tmux session 清單 | 終端機預覽、diff 分頁 | 進到 tmux 回答 | 本機 | 進度只有終端機輸出 |
| [Sculptor](https://github.com/imbue-ai/sculptor/blob/main/docs/help/changes.md) | workspace 和 agent 分頁 | 累積的未提交 diff、終端機 | 對話、核准計畫 | 本機 | 同檔案同時改會衝突 |
| [Paradev](https://docs.paradev.com/agent-status)（Superset） | 側欄狀態與通知 | diff、PR 留言、檢查 | 回饋給 agent | SSH 加中繼，可以管遠端主機 | 狀態靠 hook 和包一層啟動；有人回報遠端常斷線 |
| [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent) | Agents 視窗跨 repo | 對話、改動、截圖、影片、log | 追問、遠端桌面接手 | 雲端 VM | 有人回報跑到一半卡住、永遠不結束 |
| [Codex](https://openai.com/index/introducing-the-codex-app/) | 側欄依專案分執行緒 | diff、測試結果 | 回饋、權限請求 | worktree、雲端 | 只管 Codex |
| [GitHub Agent HQ](https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/agent-management) | 跨 repo 的 agent 面板 | 即時 log、PR diff、檢查 | 引導、停止 | GitHub 託管 | 以 repo 為中心，不是機器總覽 |
| [Devin](https://docs.devin.ai/release-notes/overview) | **工作中、可以審了、卡住、閒置**：把「可以審」和「卡住」分開 | 進度、shell 歷史、IDE、瀏覽器 | 接手前先暫停；[Devin 管 Devin](https://cognition.com/blog/devin-can-now-manage-devins) | 隔離的機器 | 只限 Devin 自家 |
| [Warp](https://docs.warp.dev/platform/managing-cloud-agents/) | 面板篩選工作中、卡住 | 對話、產出 | 手機遠端控制本機 CLI agent | 雲端或本機 | 「卡住」不一定能接續 |
| [Zed](https://zed.dev/docs/ai/parallel-agents) | 平行執行緒側欄 | 合併 diff，逐段接受或拒絕 | 工具權限 | 本機、SSH | 沒有跨機器的總覽 |
| [Factory](https://docs.factory.com/workstreams/steer) | 主 agent 帶子 agent：**等你、工作中、閒置**，最近活動 | PR 檢查、diff、審查、報告檔 | 打開子 agent 回覆、核准、停止 | 雲端、本機、[自己的機器](https://docs.factory.com/workstreams/machines) | 直接對子 agent 下的指示，還要另外告訴主 agent |
| [Amp](https://ampcode.com/docs/spaces) | Spaces 裡的平行執行緒 | 對話、工具呼叫、diff | 引導、排隊訊息、中斷 | 託管或[自己的 runner](https://ampcode.com/docs/cli/runners) | runner 以啟動者的系統身分執行 |
| [Omnara](https://github.com/omnara-ai/omnara) | 執行中、等互動、閒置、封存 | 核准和問題卡片、產出 | 卡片 | [多台機器的 daemon](https://docs.omnara.com/machines/overview) | diff 審查和手機推播還不確定 |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck)、[Herdr](https://herdr.dev/tui/docs/agents/)、[Rex](https://www.superlogical.com/rex/docs/build/program-status) | 執行中、等待、閒置、錯誤 | 終端機預覽 | 回到終端機 | 本機、SSH | Herdr 靠認畫面，陌生的提示會漏；Rex 有明確的狀態協定 |

已經收掉或停止的：Terragon（2026-02 結束服務）、Google Jules（唯讀，12-31 關閉）、Vibe Kanban 的託管服務。

## 值得借的概念（不借外觀）

1. **注意力和任務階段分兩條軸**（Nimbalyst）：「需要我嗎」和「做到哪一步」是兩件事。
2. **「可以審了」不等於「卡住」**（Devin）。
3. **agent 的狀態不等於檢查的狀態**（Conductor）：agent 閒著，CI 可能還在跑。
4. **不離開目前畫面就能偷看即時的工作**（Nimbalyst）。
5. **以產出為主來檢查**：diff、測試、截圖，而不只是對話。
6. **行內回饋直接變成給 agent 的指示**（Conductor、Paradev）。這跟 pi mobile 的「點一段當作下一則訊息的對象」同方向。
7. **主 agent 和子 agent 的層級，往下鑽、結果彙整回來**（Factory、Devin）。
8. **明確的接手與交還**（Cursor、Devin）。pi mobile 的瀏覽器接手已經是這個概念。
9. **在哪裡執行和從哪裡看分開**（Factory、Amp）。
10. **由 agent 回報生命週期事件，而不是猜終端機畫面**（Rex 的狀態協定）。

## 沒有產品填補的空缺，正好是 pi mobile 的位置

- 一個以 iPad 為主的指揮台，**接手多台個人電腦上既有的、不同來源的 session**（Herdr、Rex、hc），不要求換掉它們。
- 一套共同的狀態：執行中、等權限、真的卡住、斷線、可以審了、驗證過的完成。
- 進度以產出和檢查為根據，有主從關係可以追，而不只是 agent 自己寫的摘要。
- 手機上的私人主 agent 有選擇地交辦，不把整個私人脈絡上傳；電腦上的 agent 只拿到這件事的指示，回傳證據。
- 不同來源的 agent 用同一套介入方式：回覆、核准、暫停、接手、取消。

astra 的總結：要做的是缺的那一層「監督層」，不是另一個 IDE：注意力收件匣、機器與 session 的名冊、正規化的事件、往產出鑽下去，以及清楚的交辦邊界；終端機接手是最後的逃生口。

## pi mobile 現在有的資料（fable 盤點）

| 單位 | 狀態 | 即時或輪詢 |
|---|---|---|
| Bot | 存在、移除中 | 即時，全部 Bot |
| 回合 | 忙或不忙 | 即時，全部 Bot，只有布林值 |
| 回合的步驟 | 等待、執行、完成，加輸出 | 即時，只有打開的那個 Bot |
| 問題（`ask_user`） | 開著、已回答 | 即時，只有打開的那個 Bot |
| 表單 | 等待；接受、拒絕、跳過、取消、無人值守 | 即時，全部 Bot（等待中的只在記憶體） |
| 排程、追蹤、watch | 開、暫停、已觸發；上次跑了、跳過、失敗 | 即時，全部 Bot |
| 事項 | 待辦、等回覆、完成 | 即時，全部 Bot |
| 背景 job | 執行中、結束、逾時、停止、遺失 | 結束時推播；輸出要偷看時每 1.5 秒輪詢 |
| 電腦上的 agent | 閒置、工作中、等使用者、不明，加上消失、連不到 | **沒有存也沒有訂閱**：只有模型呼叫 `list_agents` 時列一次；watch 用鬧鐘 1、3、10 分鐘重查；舞台上每 1.5 秒讀畫面 |
| 瀏覽器任務 | 進行中、交給使用者 | 即時；截圖每 2 秒輪詢 |

所以現在 UI 只有在某個 Bot `tell_agent` 之後才看得到那個電腦 agent，而且只限打開的那個 Bot。

**後台還缺的資料**：每台電腦上所有 agent 的名冊、每個 agent 的任務或目標（現在埋在 watch 的 prompt 字串裡）、Bot 和工人之間的指派紀錄（watch 看到完成就刪了）、進度階段（只有 Rex 有 `doing`）、歷史（只有 `Trigger.last`）、成本（只有打開的對話的 token）、工人改了哪些檔（可以在工人的 `cwd` 跑同樣的 git 指令）、經過時間。

## 資訊架構草案（fable，iPad 橫向）

```
┌────┬─────────────────────┬──────────────────────────────┬─────────────┐
│頭像│ 名冊（新）           │ 舞台                          │ 對話         │
│條  │ 需要你 2             │ 進行中 · rex:c834ae · 3:12    │（這個單位所屬│
│ π  │  Claude · pi-mobile │ ┌──────────────────────────┐ │  的 Bot）    │
│ 🤖•│   等你同意 curl      │ │ 終端機 / 檔案 / 表單 / 截圖 │ │              │
│ 🤖 │ 進行中 3             │ └──────────────────────────┘ │              │
│ 🤖◦│  求職 Bot · 第 5 步  │ [允許] [拒絕]        [下一件] │              │
│ ＋ │  Codex · api · 3:12 │──────────────────────────────│              │
│ ⚙  │  job 跑單元測試      │ 托盤：這個單位的產出、來源、    │ [輸入框]     │
│    │ 閒著 5               │ 最後的回報                     │              │
└────┴─────────────────────┴──────────────────────────────┴─────────────┘
```

- 頭像條決定範圍：π 是全部，頭像是單一 Bot。名冊列出單位（回合、agent、job、問題），點一列決定舞台放什麼；托盤是這個單位的產出；對話跟著這個單位所屬的 Bot。
- 資料介面：每個功能匯出自己的 handle（`subscribe` 加上它自己的動詞），工作台只拿 handle，不 import `AgentRuntime` 或 `HostCommands`。已經有四個：`triggers`、`forms`、`browserState`、`subscribeActivity`。缺三個：電腦 agent 的名冊（自己決定多久讀一次：名冊看得到時 10 到 15 秒一次，只有舞台上的那個每 1.5 秒讀畫面；之後換成事件串流，工作台不用改）、jobs、每個 Bot 的回合摘要。
- 這要先完成模組分層（見 AGENTS.md 和進行中的模組化計畫），工作台才只透過 handle 讀資料。

## 下一步

1. 模組分層：A（jobs）、B（排程不認識 items 和 agent）、各功能的 handle。
2. 電腦 agent 的名冊和狀態正規化（上面的六種狀態），先用 CLI 讀；之後做 `/agents/events` 事件串流，電腦端回報事件，不再猜畫面。
3. 寫核心目的和量測方式，出設計圖給使用者確認，再一區一區做，每區用 iPad 實測。
