# 資料庫設計：一份 database-architect 指引對 pi mobile 的用處（2026-11-15）

使用者貼了一份「database-architect」agent 指引（以 PostgreSQL 為主：主鍵與型別、約束放在資料庫、多租戶的 row-level security、不鎖住正式資料表的線上遷移、交出前先在真的資料庫上跑過）。問題是它對 pi mobile 有沒有用。

## pi mobile 實際怎麼用資料庫

- **手機上的使用者資料庫**：`sql` 工具（`src/agent/tools/database.ts`）讓 Bot 對一個 SQLite 檔案執行語句，同一批在一個交易裡（全部成功或全部不做）；原生端開檔時設 `PRAGMA foreign_keys = ON`（`DatabasePlugin.kt:28`，SQLite 預設是關的）；擋掉 `ATTACH`、`DETACH`、`VACUUM INTO`。匯入試算表時程式自己建表（`attachments-sheet.ts:84-93`，全是整數的欄位用 `INTEGER`，其餘數字用 `REAL`）。
- **給 Bot 的指引只有一句**：「英文命名、時間寫 YYYY-MM-DD HH:MM、金額寫數字、為要篩選或加總的東西開欄位」。
- **電腦上的資料庫**：Bot 在電腦上用 `sqlite3` 自己建（例如求職紀錄），完全沒有指引。
- **App 自己的資料**：pi-durable 的 doc（例如 `TriggerDoc` 有版本號和遷移函式），不是 SQL。
- **S24 實測**（2026-11-15，DevTools）：SQLite 3.50.6，`foreign_keys` 是 1；手機資料庫目前沒有使用者的資料表。

## 指引裡哪些適用、哪些不適用

| 指引 | 對 pi mobile |
|---|---|
| 多租戶、row-level security、連線池 | 不適用：一支手機一個使用者，沒有伺服器 |
| 線上遷移（鎖逾時、`CONCURRENTLY`、expand/contract） | 不適用：本機 SQLite 沒有同時在跑的舊版程式；但「改結構前先想清楚、不可逆的要先確認」適用 |
| **約束放在資料庫**：`NOT NULL` 為預設、`CHECK`、`UNIQUE`、有意識地選 `ON DELETE` 的外鍵 | 適用，而且更重要：寫資料的是模型，會犯錯；資料庫自己擋才可靠 |
| **型別**：金額不用浮點、時間要有時區 | 適用。現在「金額寫數字」會讓模型用 `REAL`，加總會有浮點誤差；SQLite 是動態型別，宣告 `INTEGER` 的欄位照樣塞得進文字，要用 `STRICT` 表才擋得住（3.37 起支援，S24 是 3.50.6） |
| 只為真的查詢建索引、先正規化 | 適用，原則一樣 |
| **交出前先在真的資料庫上跑過** | 適用，改成 Bot 的做法：改結構和大量更新放在同一批（`sql` 本來就是一個交易），最後一句是驗證查詢；會刪資料的（`DROP`、刪欄位、大範圍 `DELETE`）先問使用者 |
| 選資料庫：從 PostgreSQL 開始 | 不適用手機；電腦上的個人資料也用 SQLite 就夠 |

## 建議

1. **做成一份內建的 skill「資料表設計」**（不放進系統提示，Bot 建表或改結構前才讀，系統提示只多一行）：`STRICT` 表、`NOT NULL` 為預設、`CHECK` 寫允許的值、金額存整數（新台幣是元，外幣是分）、時間存 `YYYY-MM-DD HH:MM` 的當地時間並註明、自然鍵加 `UNIQUE`、外鍵寫明 `ON DELETE`、只為會用到的篩選建索引、改結構時同一批最後放驗證查詢、會刪資料的先問。手機和電腦上的 Bot 都適用（電腦上用 `sqlite3` 時一樣）。這符合 skill 的方向：先做純文字、Bot 用到才讀的 skill（見 [skills.md](skills.md)）。
2. **試算表匯入建 `STRICT` 表**，每一列都有值的欄位加 `NOT NULL`；看起來像金額的小數欄位維持 `REAL`（匯入時無從得知幣別），由 skill 提醒之後轉換。
3. 不做：多租戶、RLS、遷移工具、換資料庫。
