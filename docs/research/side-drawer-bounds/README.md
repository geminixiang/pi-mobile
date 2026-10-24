# 側欄展開邊界

## 症狀與重現

S24 的左右側欄完全展開後，再往展開方向拉，仍會越過邊界。`test/side-panels.mjs` 透過 WebView CDP 發送真實 touch 事件，在手指尚未放開時量測 popup 的位置與寬度。

修前：左側 x 從 0 → 14.708 px；右側 x 從 50.401 → 35.693 px。寬度沒有變，問題是整個側欄位移，不是被改寬。兩側都能穩定重現。

## 原因與修補

Base UI 1.9.0 在不允許的方向上仍給平方根阻尼位移；開啟途中的 `DrawerSwipeArea` 也有另一段過拉阻尼。這是套件預設，但不符合本 app「展開到邊界就停止」的規格。

只把 CSS 的 `translateX` 改成 min/max 無效：滑動時 `useSwipeDismiss` 會直接寫 inline transform，蓋過 stylesheet。因此沒有使用 `!important`、MutationObserver 或第二套手勢去搶位置。

`vite-plugins/side-drawer-bounds.ts` 在建置時對兩處做小範圍轉換：

- `useSwipeDismiss`：只對 Drawer 的水平滑動，限制最終 offset 不越過展開邊界。限制的是最終位置，不是手指 delta，所以也涵蓋在過渡動畫中接手拖曳。
- `DrawerSwipeArea`：水平開啟的剩餘距離最低為 0，不再越過完全展開的位置。

垂直 Drawer 與 Toast 不改。元件、開關動畫、反向關閉、scroll arbitration 與位置擁有者仍是 Base UI。

轉換要求每個來源錨點恰好出現一次；不符合就明確失敗，不默默漏套。Vite dev 排除 Base UI 預先打包，並處理模組 URL 的版本 query，確保 dev 與 production 都套到。

## 驗證

S24 真實 WebView 的以下情境均通過：

- 左、右完全展開後繼續向外拉：額外位移皆 **0 px**。
- 從聊天頁一路滑開並拉過頭：不越過邊界。
- 關閉拉到一半，再反向拉過原點：停在展開邊界。
- 反向拉回後仍能再正常滑動關閉。

`test/side-panel-patches.ts` 從套件實際程式碼擷取計算段，驗證不同初始位置、正負位移、雙側邊界、開啟路徑，以及垂直 Drawer／Toast 不變；另外檢查來源錨點與 dev query。已加入 `npm run check`。

隔離 worktree（`87b7328` 加本次修補）的 `npm run check` 與 production build 通過；Vite dev 實際模組轉換也通過。共用主工作樹最後重跑 `npm run check` 亦通過。本次沒有修改 stylesheet，也沒有覆寫其他工作。

### 效能輔助觀察

S24、120 Hz、暫時的空白測試 Bot，panel 場景各暖機一次、測五次，原始報告在 `before.json`、`after.json`：

| 中位數 | 修前 | 修後 |
|---|---:|---:|
| gfx janky | 3.7% | 3.7% |
| gfx P99 | 16 ms | 16 ms |
| GPU P99 | 6 ms | 6 ms |
| rAF P99 | 8.5 ms | 8.5 ms |
| rAF missed | 0.2% | 0.5% |
| >33 ms 幀 | 0 | 0 |

測試期間共用工作樹有其他變更，手機程序也曾重開；修後裝置已包含本次邊界修補。這些數字只作輔助觀察，不當成嚴格單變因的效能提升或零退化證明。固定手勢的幾何斷言才是本缺陷的判準。

暫時的 CSS probe 與測試 Bot 已清除；保留使用者當時選取的 Bot，沒有重設資料。

## 重跑

先在裝置開啟名稱以 `test`、`tmp` 或「測試」開頭的 Bot，收起所有側欄，再轉發 DevTools：

```sh
CDP_PORT=9333 node test/side-panels.mjs
node test/side-panel-patches.ts
npm run check
```

側欄測試不送模型訊息、不修改 Bot 設定；在手勢中斷或測試結束時釋放 touch。
