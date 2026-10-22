# WebView 版本工作區 PoC

借用 LayerFS 的分支、不可變內容與修改層概念，不依賴 LayerFS、FUSE、Docker 或 Node runtime。
這是刻意隔離的實驗，沒有註冊 agent tool、改 UI 或遷移現有資料。

## 試跑

```sh
npm ci
npm run test:workspaces
npm run dev
# 瀏覽 http://localhost:5173/experiments/versioned-workspace.html
```

示範會寫入專用 IndexedDB `pi-versioned-workspace-poc`；重新整理後再次執行，原版本應接續上次的 head。
測試使用 fake-indexeddb 驗證交易與跨連線語意，不是 Android WebView 的斷電耐久性證明。
尚未在實機驗證；合併前應以 WebView/CDP 執行相同示範、關閉／重開程序並核對 head 與未提交修改。
HTML 是開發入口，不包含在正式 app 的 Vite 入口；模組也沒有從正式 app 匯入。

## 資料與操作

- SHA-256 整檔文字去重；commit 保留完整 path → hash 索引與單一 parent。
- fork 只存 commit ID；workspace 保存 base 與持久化 changes，null 表示刪除。
- `commit(workspace, target, operationId, message)` 是將 workspace 的修改三方合併到指定分支。
  不同路徑合併、相同內容收斂、真正的同檔衝突拒絕整筆交易，保留 workspace 以供處理。
- 內容、workspace、commit、head、操作回條都在同一個 IndexedDB readwrite 交易寫入。
  同時開兩個 store 也由 IndexedDB 序列化，不只靠單一 JS instance 的鎖。
- digest 在交易前完成，交易 callback 內沒有 await，避免 IndexedDB 自動關閉交易。
- operationId 必須代表一個提交意圖。重播相同 ID 回原 commit，不再提交後續修改；
  ID 搭配不同 workspace／target／message 會拒絕。這不涵蓋外部 API 副作用或 write 的排序去重。
- 舊 commit 永不修改。可 fork 舊 commit 再建立 workspace 讀取或嘗試新方案。
- 不提供完整 branch merge DAG、行級合併、目錄語意或 POSIX 相容性。

## 邊界與後續

PoC 將全部狀態放在單一記錄，因此每次操作會反序列化整個 Store，寫入會複製整個狀態。
這只能驗證語意，**不是可擴充的儲存引擎**。去重僅指持久化內容物件，不代表實際交易 I/O 最小化。
沒有 GC、匯出、容量上限、加密或自動備份；歷史與操作回條持續成長。
刪除檔案不會抹除歷史內容。勿存憑證、隱私資料或不可重建資料的唯一副本。
IndexedDB 受 WebView origin、quota、清除 app 資料與平台耐久性影響；不是安全隔離邊界。
這個 store 的 ID 也不是權限檢查，不能直接暴露給不受信任的 bot。

下一步先量實機儲存量／延遲、程序被殺後的恢復，再決定沿用 IndexedDB 或接既有 Native SQLite adapter。
要正式接工具時，另做 bot/project 授權範圍、大小限制、工具成本量測與操作 ID 整合；不改動現有 MEMORY／對話資料庫。
