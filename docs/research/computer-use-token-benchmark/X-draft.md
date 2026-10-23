# X 草稿（尚未發布）

## 中文：建議兩則一起發

### 1

我把自己的 computer-use MCP 跟 domdomegg/computer-use-mcp 1.8.0 跑了 30 次 GUI 任務：訂單修改、三階段報銷、跨頁批次更新。

同模型、每題各 5 次。
總 tokens：4.81M → 1.48M，少 69.2%（含快取）。
成功：對照 15/15，我的 14/15。

漏填備註那次也保留，沒挑最好看的結果。

### 2

只看雙方都成功的 14 組配對，總 tokens 仍少 68.4%。

有趣的是，我的截圖更多（169 vs 141），但模型來回更少（184 vs 520）。批次動作＋操作後附圖，值得測。

限制：單模型路由、三個自製 GUI workflow，不是通用能力排名。未快取 input 只少 30%，不等於帳單省 69%。

原始 usage、失敗紀錄、state 判分與腳本一起公開。

## English: compact standalone version

30 GUI runs, same model route. My computer-use MCP vs computer-use-mcp 1.8.0:

Total tokens: 4.81M → 1.48M (−69%, cached input included).
Success: 14/15 vs 15/15.

On 14 pairs both completed: −68% tokens.

Small, synthetic benchmark—not a universal claim or billing reduction.

## 發文前

- 把本機報告與去除模型 reasoning 的資料上傳到願意公開的位置，再補實際連結。現在只有本機檔案，不要寫成已公開。
- 模型 route：CLIProxyAPI `gpt-6.1-sol`、low reasoning。不要擴寫成所有 GPT／Claude 都成立。
- 「原始 usage」是 API 回報，不是供應商帳單稽核。
- 30 次包含三題／兩組／各五次，不能寫成 30 種不同任務。
- 兩邊都允許同輪多個 tool calls。這次是 direct function-tool loop，不是 code-mode harness，也不是手機 app 的端到端測試。
- 14/15 與 15/15 不足以推論可靠度差異有統計顯著性，但必須如實揭露。
