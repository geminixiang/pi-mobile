# 工具組偏好：Bot 存工具組，工具自己宣告組

狀態：已實作（2026-11-09）。取代先前的轉換清單草稿與本文件前幾版（存擴充名字、`STEPS`／`MigrationDoc`、偏好文件加 bootstrap）。

## 問題

每個 Bot 的開關原本存的是**擴充名字**（`pi.agent.extensions.remove`）。擴充是程式的打包方式，常常整理：

- 改名、拆開，存著的名字就對不上，被關掉的能力會默默回來；
- 兩個組共用一個擴充（`coding-tools` 同時屬於「檔案」和「電腦」），開關會互相牽動：手機上關「檔案」再開「電腦」，`bash` 又回來了。

pi coding agent 的 `pi config` 也存內部結構（套件裡的檔案路徑），一樣怕改名，只是它是一份全域設定、給開發者用，痛不出來。

## 做法

| | 是什麼 | 存在哪 | 能不能改 |
|---|---|---|---|
| **工具組** | 使用者看到的開關 | Bot 本身：`Bot.off`（`BotIndex`），關掉的組 id | id 不改；標籤、說明可以改 |
| **擴充** | 實作與載入的單位 | 不存 | 隨意改名、拆、合、搬工具 |
| **工具** | 模型和腳本呼叫的名字 | 不存（`tools.remove` 是推出來的） | 可以改；舊對話裡模型可能照舊名叫一次，拿到「工具不存在」後改用新名 |

1. **工具自己宣告組**：`defineAppTool({ name, groups: ["weather"], … })`，固定開著的寫 `"always"`。漏寫就是 tsc 錯誤。外部工具（pi-durable 的 `CodingTools`、codemode、`tool_search`）在建立它們的地方用 `adopt` 補上，進同一個 `WeakMap`（`declarationOf`）。
2. **catalog 算出 `owners`**：已安裝的工具 → 它的組。一個工具的所有組在這台裝置都不可用（組的 `needs`），或工具自己的原生方法沒實作，就不安裝。
3. **投影**：`removedTools(owners, off, place, native)`。工具留下，當且僅當它是 `"always"`，或它有一個組「沒被關、可用、在這個地點」。一個工具有多個組時，它們的 `where` 必須不同（檢查擋），所以每個地點只有一個組管它。
4. **寫入只有一處**：`BotToolsets`。開 runtime（全部 Bot）、切開關、撤銷 MCP 授權、Bot 換地點時，在一筆交易裡更新 `Bot.off` 並用 `configure(tx)` 寫 `pi.agent.tools.remove`。`pi.agent.extensions` 只剩 MCP 服務的 `add`。
5. **`addTools` 過濾**：`ToolFilterExtension` 最後安裝，只有一個 `afterTool`，把 `control.addTools` 裡現在被移除的名字拿掉，合法的需要時載入工具照常載入。界限：排在它之後的 `afterTool` 能繞過，所以程式規則只允許 `tool-filter.ts`、`codemode.ts` 有 `afterTool`，只允許 `tool-filter.ts` 讀 `addTools`。
6. **說明段落跟著工具**：`appSection(key, budget, render, { about: tools })`，`about` 裡任一工具出現在 agent 的 `tools`／`callable`／`deferred` 才渲染。用在九個組專屬段落；「電腦被移除」的說明拆成沒有 `about` 的 `workplace` 段落。codemode 與 on-demand 的工具清單依**工具**的組取標籤。
7. **MCP 服務**照舊：一個服務一個擴充，以服務為單位開關（`extensions.add`），撤銷時從每個 Bot 拿掉。

## 舊資料（breaking change 的唯一過渡）

`Bot.off` 是 `undefined` 的舊 Bot，第一次經過 `BotToolsets` 時用 `legacyOff` 從存著的擴充名字換成工具組（四個 2026-11-02 前的舊名一起認，`coding-tools` 對到「檔案」和「電腦」），同一筆交易寫回 `Bot.off`、清掉舊的 `extensions.remove`。所有 Bot 都轉過之後，下一版可以刪掉 `legacyOff` 並讓 `off` 變成必填。

不全部重置成預設開的原因：管理者 Bot 升級後會突然能跑 `bash`，直到使用者發現。

子對話（task-owned）建立時由 pi-durable 照抄擁有者已推好的 `pi.agent`，不另外處理。

## 驗證

- `test/contracts/where.ts`：手機上關「檔案」、開「電腦」，`read`／`write`／`edit`／`bash` 都不在，`files` 段落也不在（舊程式失敗）。
- `test/contracts/bots.ts`：舊 Bot 的擴充名字（含舊名）轉成工具組，請求裡跟著拿掉工具，`Bot.off` 寫回。
- `test/toolsets.ts`：`legacyOff`、`removedTools` 的地點、共用工具、裝置缺能力、不認得的組 id。
- `test/tools-node.ts`：每個工具都有宣告；多組時 `where` 互斥；`*_as_user` 工具只在 `*_as_user` 組；快照記錄 `groups`；工具總圖由宣告產生。
- 離線探針（本機暫存）：pi-durable 1.5.0 的 `addTools` 過濾順序、段落三個集合、同一擴充兩組各自開關。

## 對未來的影響

- 移除：Bot 設定綁擴充名字、共用擴充讓開關互相牽動、`RENAMED`、`ALWAYS_ON`、`test/extensions.snapshot.json`、工具「沒宣告」的豁免。
- 新增：`Bot.off`、`groups` 宣告與 `adopt`、`removedTools`、`ToolFilterExtension`、`appSection` 的 `about`、三條檢查。
- 留給之後：所有 Bot 轉完後刪 `legacyOff`；工具換組時要不要保留「原本關著就關著」，到時再決定政策。
