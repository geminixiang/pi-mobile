# Claude Duet 與 pi mobile

調查日期：2026-11-13。對象：Claude Duet Android 1.261112.20（`com.anthropic.aibo`），在 S24 上用使用者的 GliaCloud 團隊帳號，逐頁看過，並實際交辦任務（第 3 節）。問題：Anthropic 把 Duet 定位為「主動式代理程式」，這個「主動」具體做了什麼？和 Meta Muse、Grok Bot（[grok-bot.md](grok-bot.md)）、OpenAI dots 比起來如何？pi mobile 該借哪些？

除非特別註明，下面的內容都是實際操作看到的。Duet 對自己的描述（例如簡報時間）是它自述，標「自述」；官方說法附上來源。

## 結論先講

- **Duet 的「主動」不是一個功能，而是預設的作息**。它自述：
  - 每天台北時間早上 8 點送簡報。
  - 白天 9 點到 22 點，約每 3 小時看一次連接的 App，有急事或卡住的事才傳，一天最多兩次。
  - 23 點到 8 點不打擾。
  - 第一週每天早上各有一則引導訊息（skill `first-week-day-1` 到 `7`）。
  - 使用者什麼都不用設定。pi mobile 也做得到同樣的事（排程、事件觸發、`notify`），但要使用者自己開口要求。
- **交辦出去的工作是「任務」，不是一段對話**。每件事有自己的串和狀態（需要你、可檢查、已停止、已排定、稍後），集中在 Tasks 分頁。對話裡只放一個連結和一句結論。人可以離開，回來看任務板就知道每件事做到哪。
- **只要會動到外界，就要按兩次**：
  - 先按草稿卡上的「Send」。
  - 再按權限卡上的「Allow once」，卡上寫著是「組織要求核准這個工具」。
  - 解 CAPTCHA 也要另外允許一次。
- **雲端電腦是預設的手**：
  - 上網、做頁面都在 Anthropic 的雲端機器上跑，App 關了也繼續（官方：research preview，用 Opus 5.5，和 Claude 方案共用額度；[claude.com](https://claude.com/resources/articles/claude-duet)）。
  - 使用者自己的電腦（Claude Code `remote-control`、Claude in Chrome）是第二條路。
- **pi mobile 最該借的，依序是**：
  1. 預設的作息（晨報、少量的巡視、安靜時段、每天上限）。
  2. 任務板。
  3. 動作前的草稿卡和權限卡分開（pi mobile 已有確認卡，見 grok-bot.md 第 4 項）。

## 1. 同一類產品

| 產品 | 形式 | 「主動」怎麼做 | 動作前 |
|---|---|---|---|
| Claude Duet | 獨立 App（iOS、Android）＋ claude.ai/messages | 晨報、巡視連接的 App、任務做完或要決定時傳訊息；在雲端電腦上繼續做 | 寄信、付款、簽署、刪除都要核准；證券交易不做（[claude.com](https://claude.com/resources/articles/claude-duet)） |
| Meta Muse | 獨立 App、WhatsApp、網頁（2026-09-08，美國） | 把目標拆成計畫、App 關了繼續做、建議下一步（[about.fb.com](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)） | 寄信、購買要核准 |
| OpenAI dots | ChatGPT 裡的一個常駐 agent | 給它一個長期目標，它定時檢查、在對話之間工作、帶更新或待決定的事回來（[help.openai.com](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)） | 主動研究時不能自己發訊息給別人或改內容 |
| Grok Bot | 獨立 App | 例行任務、Bot 先開口、問題卡（[grok-bot.md](grok-bot.md)） | 郵件卡，可以設定以後這個收件者不用問 |
| pi mobile | 手機 App，agent 在手機上跑 | 使用者建立的排程和事件觸發（時間、地點、通知、耳機…），`notify` 由 agent 判斷要不要通知 | 確認卡、`ask_user` |

四家的方向一致：agent 有自己的電腦和作息，人從「開對話」變成「收訊息、做決定」。差別在於主動是**預設開著**（Duet、Muse、dots），還是**使用者開口才有**（pi mobile 目前的做法）。

## 2. 介面

### 結構

- 底部 Chat、Tasks、Make 三個分頁。右邊另一顆圓鈕是 Sessions（電腦）。
- 標題列浮著三顆圓鈕：
  - 左邊 Channels。
  - 中間是 Claude 的吉祥物，會變形表示狀態：波浪、一團、兩點。
  - 右邊帳號縮寫。
- 對話的樣子：
  - Claude 是灰色泡泡，使用者是橘粉色泡泡。
  - 底部輸入框有 ＋、麥克風、黑色的「Talk」。
  - 最下面一行「Claude Duet is AI and can make mistakes.」。
- 對話裡的任務是一個可以點的標籤，前面的小圖示表示狀態（👁 等你檢查、✋ 需要你、⏸ 停了），後面接「New replies」；Tasks 分頁有新狀態時亮紅點。
- 每個回答後可以有 1 到 2 個「↳」選項，一點就回（「晚點再試一次」「Shorten」）。
- 介面是英文。Claude 照使用者的語言回答。系統字串有些是中文，例如「拖曳控點」「關閉功能表」，所以兩種語言混在一起。

### 各頁

| 頁面 | 內容 |
|---|---|
| Channels | 「Everything（所有頻道的對話脈絡）」和「New channel」（名稱、圖示）。有些 skill 只在特定頻道用（文案、設計、教學） |
| Tasks | Active／Up next 兩頁、分組、搜尋、＋ Add a task（「把要做的事都打進來，Claude 拆成任務給你勾」）。分組：Ready for review、Needs input、Stopped、Scheduled、Saved for later。每個任務一條串，可以回覆。有新狀態時，分頁上亮紅點 |
| Make | 「Make something that works for you」，範例「Daily todo」「Email triage」；做好的頁面集中在 Artifacts |
| Sessions | 「New session」、需要你的 session、我的電腦（「No computer of yours yet」＋ Add a computer）、「In the cloud · Claude's own computer · Always on」 |
| 帳號設定 | Accounts（可以多個帳號）、Computers、Connections（4 connected）、Plugins（團隊的 GliaCloud 外掛）、Usage（和 Claude 方案共用：目前這段 54%、每週 45%、Fable 22%）、Notifications「Get notified」 |
| Connections | 最上面只推薦 Google Calendar、Google Drive suite、Slack、1Password；已連 Gmail、GitHub、Claude Data、Meetings；下面是另外約 90 個（Notion、Canva、Microsoft 365、Zapier、Stripe、Uber…），每個寫「Connects to a site under …」。1Password 寫明每次要用登入資訊都要在 1Password App 裡核准，密碼不交給 Claude |
| ＋ | 相機、照片、檔案、連接器、Skills、New session |

### 連服務的流程（使用者實際操作，2026-11-13 17:27–17:28，約 22 秒）

1. **點標題列中間的 Claude 吉祥物**，整頁從吉祥物放大出來：「Claude · What Claude has access to」。
2. 這一頁**按用途分組，不按服務分**。每一組一列，右邊是已連服務的圖示，沒連就是虛線框的「＋」：
   - Files and docs
   - Mail（Gmail · Can read and draft your mail）
   - Calendar
   - Team chat
   - Credentials（Can’t sign in for you yet）
   - More apps
3. **點 Calendar 的「＋」**，在 App 內的 Chrome 分頁（Custom Tab）打開 Google 授權。
   - 畫面是「登入『Claude for Google Calendar』」，已經帶好帳號。
   - 按「繼續」就回到 App，不用離開 App。
4. 回來時，Connections 的「Connected」多了 Google Calendar。再返回，那一列變成「Calendar · Can see your schedule · 日曆圖示」。
5. 再返回，整頁縮回吉祥物，回到對話。

值得學的：
- **從「它能做什麼」看起，不從服務目錄看起**：每一組一句話寫明現在能做什麼（「Can read and draft your mail」），也寫明還不能做什麼（「Can’t sign in for you yet」）。
- **空著的位置畫成虛線框的「＋」**，一眼看出還缺哪一塊。
- **入口就是吉祥物本身**：點「它」就看到它有什麼能力。
- **授權在 Custom Tab 裡完成**，一來一回不到 10 秒。

沒做到的：連好之後，對話裡沒有任何反應。它沒說「我現在看得到你的行事曆了」，也沒順勢提議「要不要我看看這週行程」。Grok Bot 在連好之後會列出能用它做的事。

### Android 整合（從 `dumpsys package`）

- **數位助理**：`AiboAssistantService`、`AiboAssistantRecognitionService`，可以取代系統助理。這支 S24 目前設定的是 pi mobile。
- **快速設定方塊**：Converse、Talk、Text。
- **桌面小工具**：Home、Talk。
- **分享目標**：文字、圖片、PDF、Word、EPUB、RTF。我就是用分享傳中文問題進去的，會先跳一個「Share to Claude · Send」確認畫面。
- **Claude Code 遠端的通知動作**：允許權限、回覆 session（`CCRPermissionActionReceiver`、`SessionReplyActionReceiver`）。
- **連結**：`claude.ai/messages/chan_…`、`claude.ai/duet`，網頁版和 App 是同一套頻道。
- **權限**：要了日曆、位置、麥克風，都還沒給；通知給了；裝置日曆沒有用到，日曆走連接器。

## 3. 實際用過之後

| 交辦（用分享傳中文） | 結果 | 時間 |
|---|---|---|
| 明天台北會下雨嗎？ | 建議帶折傘，分白天、晚上，引用今早的預報；最後反問「你人在台北嗎？」 | 33 秒 |
| 今天 Gmail 有沒有要處理的？只讀 | 「今天沒有需要你處理的信，只進來兩封」，最後一句「我只讀了信，沒有回覆，也沒有改任何東西」 | 28 秒 |
| 我這週行事曆有哪些行程？ | 「我還看不到你的行事曆…到 Claude 的設定裡把 Google 日曆接上」。**對話裡沒有連接按鈕** | 22 秒 |
| 上 104 找年薪 200 萬以上的 AI Agent 職缺 | 104 擋了雲端瀏覽器，它改用「你 Mac 上的 Chrome」（skill `claude-in-chrome`），也被拒絕；10 分鐘後變成 Stopped 任務，並附上網路搜尋看到的兩家公司，說無法確認 | 10 分鐘，失敗 |
| 寫信給我自己，先給我核准 | Gmail 草稿卡（收件人、主旨、內文；Edit、Send、複製、分享、✕）；下面兩個建議回覆「Shorten」「Personalize my writing」。按 Send 後再跳權限卡：「Claude wants to send an email · Team organization: GliaCloud · Your organization requires approval for this tool」，按 Allow once 才寄 | 34 秒，加兩次按 |
| 你會主動找我嗎？ | 晨報 8 點、白天約每 3 小時、一天最多兩次、23–8 點安靜（自述）；接著問週末要不要，附兩個一點就回的選項 | 30 秒 |
| 5 分鐘後提醒我起來喝水 | 「好，4:58 在這裡提醒你」；**16:58:40 收到推播**「該起來喝水囉！」，另有一則摘要「1 個討論串等待中」 | 準時 |
| Make › Daily todo | 一頁網頁：日期、第 46 週、行事曆（未連接時說明怎麼接）、「你請我追蹤的事」自動列出前面三件事和狀態、可勾選的清單（「勾選只存在這個瀏覽器裡」）；做的時候寫「You can leave. Claude keeps working」 | 48 秒 |
| 加兩個任務：cake.me 找 3 個職缺、週一 10 點提醒準備面試 | 拆成兩個任務。提醒放進 Up next 的「Saved for later」；找職缺的任務卡在真人驗證，跳權限卡「Claude wants to solve a CAPTCHA on a website · www.cake.me · one time」，允許後找到 3 個近 3 天的職缺，附連結，放進任務 | 97 秒＋145 秒 |
| 列出 skills、你記得我什麼 | 記憶只有當天聊過的事；skills 約 40 個，見下面 | 52 秒 |

### Skills（它自己列的，加上 ＋ › Skills 看到的清單）

- **美國的生活和報帳**：`doordash-order`、`ubereats-order`、`uber-ride`、`resy-reservation`、`benepass-claim`、`brex-expense`、`expense-receipt`。
- **信和寫作**：`learn-how-i-write`、`gmail-attachments`、`copywriting`。
- **連接器**：`connectors`、`recommend-connectors`（從信箱推薦該接哪些 App）。
- **文件**：`google-workspace`、`docx`、`pdf`、`pptx`、`xlsx`、`attach-spreadsheet`、`docs`、`pages`、`dataviz`、`artifact-design`、`artifact-diagramming`、`artifact-capabilities`。
- **主動**：`brief-relay`（轉達早上簡報）、`first-week-day-1` 到 `7`、`task-cards`、`share-browser-screenshot`。
- **程式**：`code-review`、`simplify`、`security-review`、`run`、`init`、`claude-api`、`claude-in-chrome`、`loop`、`workflow-authoring`、`plugin-authoring`。

主動這件事做成了 skills：晨報、第一週的引導、任務卡，都是寫好的流程，不是模型臨場發揮。

### 看到的問題

- **粗體遇到全形冒號就壞掉**：`**數邁科技 AI 應用工程師：**` 直接顯示星號，天氣的回答也一樣。中文的冒號貼在 `**` 前面，Markdown 認不出粗體的結尾。
- **權限卡的收件人是原始 JSON**：`["geminixiang@gliacloud.com"]`。
- **要連接器時沒有給按鈕**：問行事曆，只叫你去設定。Grok Bot 會在對話裡放連接卡。
- **一件事要按兩次**：草稿卡上按了 Send，還要再按一次權限卡上的 Allow once。這是團隊的組織政策，個人帳號可能不會這樣，沒驗證。
- **長任務看不到進度**：104 那件跑了 10 分鐘才停，中間對話裡只有一個任務連結。
- **使用者的待回答問題被略過**：問了「週末要不要簡報」，我接著問別的事，它就沒再提了。
- **通知頻道的內部名稱是「bogosort」**：使用者在系統通知設定裡會看到這個名字。
- **美國的 skills 對台灣沒用**：DoorDash、Uber Eats、Resy、Brex 這類。

### 還沒測（需要使用者協助或要花較多額度，測完補進來）

- **電腦（Sessions）**：
  - 開新 session 一定要有一台使用者的電腦，作法是在要用的資料夾裡執行 `claude remote-control`，登入和手機同一個 Claude 帳號。
  - 這台 Mac mini 的 Claude Code 登入的是別的帳號。
  - 帳號清單裡有一個先前留下的雲端 Cowork session「演講重點整理」：它說聽不到直播的聲音，只能截圖看投影片，提議開 Chrome 的即時字幕。
- **Talk（語音）**：麥克風權限沒給。
- **晨報**：要等到明天早上 8 點才看得到。

## 4. pi mobile 該借的

依順序排，前面的讓後面的做得出來。

1. **預設的作息**：
   - 新 Bot 預設帶一組排程：晨報、白天少量巡視（有事才講、每天上限）、安靜時段。使用者只決定要不要，不用自己設計。
   - pi mobile 已有 `create_schedule`、事件觸發和 `notify`，缺的是預設值和上限。
   - 上限要算進「今天的自動執行」（`src/triggers/runs.ts` 的 `LIMITS`）。
   - 背景工作做完的喚醒不能被每天的上限擋掉（11/10 的問題）。
2. **任務板**：
   - 交辦出去的事變成一筆有狀態的任務：需要你、可檢查、已停止、已排定、稍後。對話裡只留一行連結。
   - pi mobile 的「事項」（`note_item`，`src/items/`）已經有 state 和 `waiting_on`，可以長成任務板。
   - 和 Bot 面板的自動化列表放在一起。
3. **草稿卡和權限卡**：
   - 草稿可以改、可以叫它「改短一點」。按下寄出時，再依權限規則決定要不要另外問。
   - pi mobile 有確認卡（`src/interaction/FormCard.tsx`），缺「建議回覆」和「以後這個收件者不用問」（grok-bot.md 第 25 項）。
4. **「它能做什麼」頁**：
   - Bot 面板放一頁，按用途分組（檔案、信、日曆、聊天、帳密），每組一句話寫現在能做的事，空著的畫虛線框「＋」，點了就連。
   - 連好後，對話裡順勢說一句「現在能做什麼」，並提議第一件事。這是 Duet 沒做到的。
   - pi mobile 現在要到 設定 › MCP 找服務，而且是按服務列，不按用途。
5. **一點就回的建議回覆**：
   - Duet 在每個回答後放 1 到 2 個「↳」選項。
   - pi mobile 的 `ask_user` 是 Bot 主動提問時才有；可以讓一般回答也附上建議的下一步。
6. **第一週的引導**：
   - 新 Bot 的前幾天，每天早上一則訊息，教一件事、提議連一個服務。
   - pi mobile 新 Bot 目前只有第一次對話。
7. **把主動做成 skills**：
   - 晨報、引導、任務卡都是寫好的流程。
   - pi mobile 的 skills（`src/agent/skills/`）可以放 `morning-brief`、`first-week`，排程只負責叫醒它。
8. **分享進來先確認**：「Share to Claude」先顯示要送的內容，再按 Send。pi mobile 的分享直接進輸入框，可以比照。
9. **從信箱推薦連接器**：Duet 有 `recommend-connectors`，看使用者收到哪些服務的信，推薦該接哪個。pi mobile 的服務目錄（grok-bot.md 第 8 項）可以用同一招排序，加上要用時在對話裡放連接卡（Duet 沒做到，見第 3 節）。
10. **快速設定方塊和小工具**：Converse、Talk、Text 三個方塊，Talk 小工具。pi mobile 已經是數位助理，缺方塊和小工具。

不借的：
- **雲端電腦**：pi mobile 的 agent 在手機上，電腦用的是使用者自己的機器，這是設計上的選擇，見 `docs/architecture.md`。
- **美國生活的 skills**。
- **讓英文介面配中文回答**：pi mobile 的介面已經是中文。
