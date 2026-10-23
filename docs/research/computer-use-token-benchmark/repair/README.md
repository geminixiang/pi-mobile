# 針對漏填備註的修補

2026-10-24。這是前一批 benchmark 之後的定點修補與驗證；**原本 30 次 A/B 數字保持不變**，不要把這次七個成功樣本混進去換掉失敗。

## 根因

原始 `confirm-orders-1-own` 在同一批次內做：關閉配送選單 → 點備註欄 → 輸入中文 → 勾核對 → 下一步。

在真實 Chrome／macOS 上重播，選單關閉動畫吞掉了緊接的點擊。事件記錄顯示：文字的 keydown 目標仍是 `SELECT name=shipping`，沒有 textarea 的 pointerdown／focusin／input。座標本來就在 textarea 裡，不是中文字型或座標換算錯誤。

把切換後等待改成 400 ms，完全相同的點擊與文字事件才進入 `TEXTAREA name=note`。在原始完整軌跡中，修後備註出現在確認頁；這會增加確認頁高度，所以最後那組原本依「漏字畫面」選的座標不再適用，不能用盲播舊後綴代替讓模型重新觀察。完整模型驗證另列如下。

重播過程也觀察到 Chrome 會記住輸入並顯示 autofill 提示；最小競態測試只建立配送選單與備註的起始狀態，關閉該測試 form 的 autocomplete，避免把第二個干擾因素混進來。後面的七次模型任務仍使用原始 fixture。

## 實作

`host/computer.go`：

1. 批次中明確的 `key return/enter/esc/escape` 後，如果還有下一步，等待 400 ms。一般點擊、打字、Tab、上下鍵仍是 60 ms；`type` 裡的多行文字不會每一行多等 400 ms。
2. 最後一步直接使用原有的批次末尾 400 ms，不再額外重複等 60 ms。
3. 某步真正回報錯誤時，停止後續步驟，回傳失敗步驟、已執行／未執行的界線，以及現場截圖和視窗資訊。截圖本身若失敗，也保留原始操作錯誤與擷取錯誤，不吞掉其中一個。

工具名稱、說明、參數和 output schema 沒有變；沒有新增工具、沒有修改提示來教模型特定題目的答案，也沒有重設工具快照。

曾嘗試透過 macOS AXFocusedUIElement 判定是否為原生選單，但這個 Chrome 情境回傳空值。沒有留下無法工作的焦點判斷，也沒有要求更多權限。採用上述明確按鍵邊界作有限同步；**不是完整的 UI-idle 偵測，也不保證所有 app 都會在 400 ms 內完成**。更慢的轉場仍須使用工具原有的 wait／觀察。

這次沒有加入欄位語意驗證：工具回傳成功仍不等於任務完成。模型依然必須看結果；新增錯誤截圖只改善工具已知失敗的恢復能力，不會自動辨識任意錯誤座標。

## 驗證

| 測試 | 修前 | 修後 |
|---|---:|---:|
| 相同原生選單競態重播 | 0/10 正確 | 10/10 正確 |
| 模型完整訂單工作 | 4/5 正確（原 benchmark） | 5/5 正確 |
| 模型報銷工作 | — | 1/1 正確 |
| 模型跨頁批次任務 | — | 1/1 正確 |

原生重播透過實際 MCP mouse/keyboard 完成，不花模型 tokens。CDP 僅用於建立治具、定位測試元件與記錄事件／判分；模型的七次任務仍只能用 MCP 圖片與操作，不拿到 DOM。

修後五次訂單的 input tokens：40,593、140,123、62,986、51,279、40,605。全部通過整份資料狀態驗證，包含非目標紀錄不變。

| 訂單指標 | 修前五次 | 修後五次 |
|---|---:|---:|
| Input 中位數 | 63,186 | 51,279 |
| Input 平均 | 66,182.8 | 67,117.2 |
| Input 總和 | 330,914 | 335,586 |
| 成功 | 4/5 | 5/5 |

**不宣稱這次修補讓 token 更省。** 中位數下降，但平均略升，一次修後執行用到 140k input；五次也不足以證明普遍可靠度。這次的強證據是已識別競態的固定輸入由 0/10 轉為 10/10。

另以真實 MCP 呼叫未知按鍵，驗證 `isError`、失敗步驟、後續不執行的警告，以及 image + text 都有回傳，見 `failure-screen.json`。

- `go test -race -count=1 ./...`（host）：通過。
- `go vet ./...`（host）：通過。
- `npm run check`：通過。
- 無殘留 `[DEBUG-computer-focus]`。
- `host/computer_test.go` 覆蓋切換點等待、一般動作不加等待、批次失敗後不執行後續、保留錯誤截圖、擷取失敗時保留兩個錯誤。

## 重跑與版本

修補前 binary SHA-256：`9c96130fa2beffbd145ef0f297a43ed6d040cf3d4e953c1cd3f2d9d76b66bcd1`。

修補後測試 binary SHA-256：`38eb6d82d955199e62ebfd2759fd85b24a51d7f2fd4927026ccb3583dcd19414`。

先依上一層 README 開治具與專用可見 Chrome，再執行：

```sh
COUNT=10 LABEL=before BINARY=/path/to/baseline node native-regression.mjs
COUNT=10 LABEL=after BINARY=/path/to/fixed node native-regression.mjs
BINARY=/path/to/fixed node failure-screen.mjs
TASKS=orders RUN_PREFIX=new-fixed REPEATS=5 node driver.mjs
```

第一個命令應失敗，後兩個原生檢查應通過。`driver.mjs` 是原 benchmark harness 的定點副本，只改 binary、單獨跑 own，以及輸出資料夾；模型、prompt、fixture 與 oracle 不變。要重跑模型測試，先依環境調整它的 binary 路徑與模型 API 設定。

`native-before.json`、`native-after.json` 保存逐次事件；`runs/` 保存七次模型 usage、操作、state 與最後畫面。公開紀錄不保留 reasoning_content。

只建置測試 binary，**未替換常駐 host、未重裝手機 app**。手機 app 外接 MCP 經 code mode 遺失圖片的問題是另一個問題，本輪沒有順便修改。
