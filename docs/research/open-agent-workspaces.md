# 開源的 agent 工作台：OpenMausBot、OpenBot（2026-11-15）

使用者要「認真研究」這兩個：[OpenMausBot](https://github.com/milind-soni/OpenMausBot) 和 [openbot.run](https://openbot.run/)。gpt-6-astra 讀了 OpenMausBot 的原始碼（`a6cd67c7`，v0.1.158）；claude-fable-5-2 讀了 openbot.run，發現它和 AG-UI 文件裡的「OpenBot」是**兩個不同的產品**，兩個都 clone 下來讀了。都沒有執行它們的程式。

## 三個專案

| | OpenMausBot | nightly-labs/openbot（openbot.run） | CopilotKit/OpenBot（open.bot） |
|---|---|---|---|
| 是什麼 | 「開源的 Grok Bot 替代品」：聊天 App，每個 Bot 背後是本機的 Claude 或 Codex | 本機優先的桌面工作區，把 coding CLI 跑成常駐的 agent 團隊 | 自架的「AI 同事」工作區，任何 AG-UI 端點都能當 Bot |
| 授權 | Apache-2.0（enterprise 目錄另外授權） | PolyForm Noncommercial（**不能商用**） | MIT，但必須搭配另外授權的 CopilotKit Intelligence |
| 腦在哪 | 桌機的 Node harness（Electron 子行程）或雲端主機；一個使用者一個家 | Electron，SQLite 是唯一的真相來源；agent 是主機上的 CLI | 伺服器：PostgreSQL 加 Intelligence 存對話和金鑰 |
| 手機 | **遙控器**：companion 在桌機旁邊做代理，Noise 加密、yamux 多工，走 Wi-Fi、Tailscale 或自家中繼 | Expo App，WebRTC 資料通道，雲端帳號換連線票 | Expo App 約 2,900 行，REST 沒有串流 |
| 預設權限 | 新 Bot 預設**完全存取** | 預設 `danger-full-access`、不問 | 刪除、寄送、分享、張貼、付款一律要問 |
| 規模 | 一週約 1,368 個 commit，`server/index.ts` 15,448 行 | 3,852 commits、127 個 release（幾乎每天） | 1,168 commits；伺服器原始碼 11-13 起改成只發映像檔 |

三個的共同點：**agent 的家都在桌機或伺服器，手機只是遙控器**。pi mobile 把最私人的 agent 放在手機上，這點三個都沒有。

## 值得借的概念

1. **Bot、對話、指派分開**（OpenMausBot）：Bot 是身分，對話是一條條紀錄，「指派」是一件工作（誰交給誰、狀態、結果、證據）。分開才看得出交辦出去的工作做到哪。
2. **指派樹**（OpenMausBot）：請求者、工人、結果、證據連成樹。對應工作後台的「主 agent 帶子 agent」。
3. **重啟時看證據**（OpenMausBot）：中斷的回合重跑一次，但紀錄顯示它已經對外動作過就不重跑；第二次中斷就標失敗。pi mobile 的續傳協定已經做到「恰好一次」，這是更上層的同一件事。
4. **「需要你」看板**（CopilotKit OpenBot）：依 Bot 分組，分成「卡在等你」（算進紅點）和「巡查回報」（可看可不看）。
5. **活動紀錄從對話本身推出來，不另存一份**（CopilotKit OpenBot）：符合「一個值只存一次」。
6. **核准的範圍和發起者**（CopilotKit OpenBot）：只這次、這個對話、以後都可以；並記下是人、排程還是交辦發起的，無人在場的執行可以篩出來。
7. **接手時拒絕 agent 的動作**（CopilotKit OpenBot）：人在操作時，agent 的動作直接拒絕而不是排隊。
8. **側邊面板的分頁註冊表，每個 agent 有自己的分頁**（nightly openbot）：就是 IDE 式「舞台」的做法。
9. **依能力協商的互動區塊，有純文字的退路**（nightly openbot）：舊的用戶端看不懂就退成一般問題；可以當 `host/protocol.json` 演進的範本。
10. **有型別的交辦**（CopilotKit OpenBot）：任務、範圍、什麼算好答案，加上深度上限，失敗要說出來。
11. **叫醒模型前先做確定性的檢查**（OpenMausBot）：排程的條件沒變就不花 token。pi mobile 的 watch 已經這樣做（不叫模型先查狀態）。
12. **可重播的行為測試**（OpenMausBot）：交辦、核准、復原的結果，和模型聰不聰明分開測。

## 不適合的

- 預設完全存取：跟 pi mobile「不替使用者核准」（`answer_agent` 要使用者自己的選擇）相反。
- 以伺服器為中心（CopilotKit 的 Postgres、Intelligence）、自建的加密中繼或 WebRTC 加雲端帳號：Tailscale 已經做到，而且對話和金鑰要留在手機上。
- 用 AG-UI 接工作 agent：Herdr、Rex、Claude Code、Codex 都不講，OpenBot 自己也要包轉接映像檔；若要統一，nightly 用的 ACP 涵蓋的 CLI 較多（推論）。
- CopilotKit 的 A2UI React renderer：會帶進另一套元件，跟 DESIGN.md 衝突（見 [agent-ui-protocols.md](agent-ui-protocols.md)）。
- nightly openbot 的程式碼：非商用授權，只能借概念。

這些概念併入 [agent-back-office.md](agent-back-office.md) 的設計。
