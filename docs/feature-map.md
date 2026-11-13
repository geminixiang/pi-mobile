# 功能地圖

pi mobile 的每個畫面和每個部分，從使用者看到的樣子列出：使用者和 agent 都用「名稱」這一欄稱呼它，「元件」是畫出它的程式。使用者說「那個左邊的」「右邊最上面那張圖」時，在這裡對到名稱和元件，不用猜。

`test/feature-map.ts`（`npm run check`）檢查這份地圖：每個寫成 `` `元件` (`檔案`) `` 的元件都在那個檔案裡；`App.tsx`、`Workbench.tsx`、`BotPanel.tsx` 畫出的每個元件都出現在這裡。新增或改名一個畫面時，同一個 commit 更新這份地圖，`DESIGN.md` 和 `docs/features.md` 用同樣的名稱。

## 手機（〈空間〉，DESIGN.md）

| 名稱 | 也會被叫做 | 元件 | 是什麼 |
|---|---|---|---|
| 對話 | 聊天、卡片 | `Chat` (`src/app/Chat.tsx`) | 中間那張卡片：一個 Bot 唯一的一條對話 |
| 標題列膠囊 | 上面那條、標題列 | `App` (`src/app/App.tsx`) | 浮在對話上的兩顆膠囊：左邊 Bot（頭像、名字、模型、上下文圈），右邊工具（瀏覽器、資料夾、⋯） |
| 訊息 | 回答、泡泡 | `EntryView` (`src/app/Message.tsx`) | 對話裡的一則，含工作行（連續的工具呼叫併成一行）和思考過程 |
| 結果卡 | 天氣卡、網頁卡 | `WeatherCard` (`src/interaction/ResultCards.tsx`)、`PageCard` (`src/interaction/ResultCards.tsx`)、`AlertCard` (`src/interaction/ResultCards.tsx`) | 工具的結果畫成對話裡的卡 |
| 問題卡 | 選項 | `QuestionCard` (`src/interaction/QuestionCard.tsx`) | Bot 問你、給你選項 |
| 表單卡 | 確認表單、權限卡 | `FormCard` (`src/interaction/FormCard.tsx`) | 要你填或確認才繼續的表單，第一次用到手機權限時的說明也是 |
| 輸入框 | composer | `Composer` (`src/app/Composer.tsx`) | 打字、附件、語音、插話或稍後 |
| 提示詞轉盤 | 轉盤 | `ScrollTab` (`src/app/PromptDial.tsx`) | 從輸入框右邊往上拖，轉出以前說過的話 |
| 背景指令條 | 跑中的工作 | `JobsStrip` (`src/jobs/JobsStrip.tsx`) | 電腦上在背景跑的指令，長按看最後幾行 |
| 左側欄 | Bot 清單、抽屜、左邊的 | `Drawer` (`src/app/Drawer.tsx`)、`BotList` (`src/app/BotList.tsx`) | 往右滑或按左上的頭像：所有 Bot、＋ 新增 Bot、設定 |
| 右側欄 | Bot 面板、右邊的、⋯ | `BotPanel` (`src/app/BotPanel.tsx`) | 往左滑或按 ⋯：這個 Bot 的一切，由上而下是下面幾項 |
| 連線圖 | 連線、模型 ← pi → 電腦 | `LinksSection` (`src/app/Links.tsx`) | 右側欄最上面：這個 Bot 在哪裡跑、接著什麼，線上只在真的有位元組時流動 |
| 能做什麼 | 工具、toolsets | `Abilities` (`src/app/Abilities.tsx`) | 依用途分組的工具，點一組拉起它的工具方塊 |
| 上下文 | context、用量 | `ContextCard` (`src/app/ContextCard.tsx`) | 上下文各部分的用量，底下是「壓縮　新的上下文」 |
| 自動化 | 排程、觸發 | `TriggerList` (`src/triggers/TriggerList.tsx`) | 這個 Bot 的自動化；設定裡的「自動化」列出全部 |
| 記憶 | MEMORY.md | `MemoryView` (`src/app/MemoryView.tsx`) | Bot 的記憶，從右側欄往右推進來的整頁；設定裡的「全域記憶」是同一個元件 |
| 模型 | 模型選單、思考強度 | `ModelSheet` (`src/app/ModelSheet.tsx`) | 按膠囊上的名字，或連線圖上的模型：依供應商分組的模型和思考強度 |
| 手機 | 這支手機 | `PhoneSheet` (`src/app/Links.tsx`) | 按連線圖上的 pi：這支手機上能用什麼 |
| 電腦 | 在哪裡跑 | `LinkSheets` (`src/app/BotPanel.tsx`)、`HostRow` (`src/app/Links.tsx`) | 按連線圖上的電腦：現在的電腦，和「在哪裡跑」的選擇（手機或哪台電腦） |
| 準備容器 | 建 image 中 | `PrepareStatus` (`src/app/HostsGroup.tsx`) | 換到電腦的容器時，第一次建 image 的進度 |
| Bot 詳情 | 編輯 Bot、改名 | `BotSheet` (`src/app/BotSheet.tsx`) | 名字、工作、頭像、記憶、刪除 |
| 事項 | 待辦 | `ItemSheet` (`src/items/ItemSheet.tsx`) | 從通知或小工具點進來的一件事項 |
| 交給哪個 Bot | 分享 | `App` (`src/app/App.tsx`) | 從別的 App 分享給 pi、又有好幾個 Bot 時問你交給誰 |
| 瀏覽器 | 瀏覽器面板 | `BrowserSheet` (`src/browser/BrowserSheet.tsx`)、`BrowserButton` (`src/browser/BrowserButton.tsx`) | 從標題列往下拉的面板；Bot 用它時地球亮一個點，要你接手時才自己打開 |
| 工作區 | 資料夾、檔案 | `WorkspaceView` (`src/app/WorkspaceView.tsx`) | 從右邊蓋過對話：Bot 的資料夾，電腦上還有 git 的變更 |
| 檔案 | 預覽 | `FileViewer` (`src/app/FileViewer.tsx`)、`DiffView` (`src/app/DiffView.tsx`) | 工作區裡打開的檔案和差異 |
| 確認框 | 對話框 | `Dialog` (`src/app/Dialog.tsx`) | iOS 樣子的確認：取消、動作 |

## 設定

從左側欄最底下打開，從左邊滑進來（`SettingsView` (`src/app/Settings.tsx`)）。首頁是 `SettingsIndex` (`src/app/Settings.tsx`)，分三區，每一列開一頁：

| 名稱 | 元件 | 頁裡有什麼 |
|---|---|---|
| 設定 › 模型 | `ProvidersGroup` (`src/app/ProvidersGroup.tsx`) | 供應商、新 Bot 預設的模型、上下文（自動壓縮） |
| 設定 › 全域記憶 | `MemoryView` (`src/app/MemoryView.tsx`) | 每個 Bot 都該知道的事 |
| 設定 › 帳號 | `AccountsPage` (`src/app/Settings.tsx`) | GitHub、Google Cloud、Cloudflare、Azure；Bot 用你的身分登入的帳號 |
| 設定 › 連接的服務 | `McpGroup` (`src/app/McpGroup.tsx`) | MCP 服務、加入服務、每個服務給哪些 Bot |
| 設定 › 電腦 | `HostsGroup` (`src/app/HostsGroup.tsx`) | 配對的電腦、新 Bot 在哪裡跑、Tailscale 上找到的 |
| 設定 › 瀏覽器 | `SettingsView` (`src/app/Settings.tsx`) | 搜尋引擎 |
| 設定 › 手機 | `PhonePage` (`src/app/Settings.tsx`) | 行事曆（`CalendarGroup`）、系統權限、背景執行、通知、代你操作 App |
| 設定 › 自動化 | `TriggersGroup` (`src/app/Settings.tsx`) | 所有 Bot 的自動化、要開的權限 |
| 設定 › 資料庫 | `DatabaseGroup` (`src/app/Settings.tsx`) | 資料表和筆數、匯出 |
| 設定 › 顯示 | `SettingsView` (`src/app/Settings.tsx`) | 顯示思考過程、預設展開工具輸出 |

## 大螢幕：工作台

iPad 和展開的折疊機（`layoutAt`，DESIGN.md〈大螢幕：工作台〉）。

| 名稱 | 也會被叫做 | 元件 | 是什麼 |
|---|---|---|---|
| 頭像條 | 左邊那條 | `Rail` (`src/workbench/Rail.tsx`) | 取代左側欄：Bot 頭像、＋ 新增、設定 |
| 工作台 | 右邊（或下面）那塊 | `Workbench` (`src/workbench/Workbench.tsx`) | 浮起來的一塊，上面是舞台，下面是托盤；左上的名字打開 Bot 的資訊（同一個右側欄） |
| 舞台 | 大的那格 | `Stage` (`src/workbench/Stage.tsx`) | 一次放大一件事，永遠回答「現在要我做什麼」 |
| 成果 | 打開的檔案 | `Surface` (`src/workbench/Surface.tsx`) | 舞台上的檔案；點一段就成為下一則訊息的對象 |
| 托盤 | 下面的小卡 | `TrayCard` (`src/workbench/Workbench.tsx`) | 需要你、進行中、成果三組小卡 |

## 共用的骨架

不是使用者會叫名字的東西，但上面的畫面靠它們排出來：`PageStack` (`src/app/PageStack.tsx`)（頁面疊上去、退回）、`SideSwipe` (`src/app/SidePanel.tsx`) 和 `SidePanel` (`src/app/SidePanel.tsx`)（側欄和手勢）、`Sheet` (`src/app/Sheet.tsx`)（底部抽屜）、`Section` (`src/app/BotPanel.tsx`)（右側欄的一區）、`BotAvatar` (`src/app/BotAvatar.tsx`)、`PiMark` (`src/app/PiMark.tsx`)、`ModelLine` (`src/app/Links.tsx`)、`Skeleton` (`src/app/Skeleton.tsx`)、`TranscriptSkeleton` (`src/app/Skeleton.tsx`)。
