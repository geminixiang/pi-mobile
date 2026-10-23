# 複雜 GUI 任務 protocol

2026-10-24。這一批是實際操作，不是 schema tokenization，也不是錄好的 action replay。

## 執行環境

- macOS 桌面，1920×1080 主螢幕；獨立 Chrome profile，只開本機合成工作台，不使用真實帳號或資料。
- 實際跑兩個 MCP server：固定建置的 pi-mobile Go binary，以及 computer-use-mcp npm 1.8.0。版本與 SHA-256 見 README 的 schema 實驗記錄。
- 相同 CLIProxyAPI 路由、模型 ID `gpt-6.1-sol`、OpenAI chat/completions API、reasoning_effort=low、max_completion_tokens=4096，沒有更換模型或替任一方加特別提示。這是供應商回報的路由名稱，不是對底層模型版本的獨立認證。
- MCP 的工具名稱、完整 description、inputSchema 原樣投影為 function tools，直接給模型。不加入 code mode、其他工具或工具搜尋。兩邊都允許同一回應包含多個 tool calls，按順序執行。
- MCP 圖片按 image content 傳給模型，detail=high，沒有改變 server 回傳的圖片。工具結果文字保留，圖片按呼叫順序附在後續 user message；兩組使用同一個 adapter。
- 不裁切舊 transcript、不刪除舊截圖、不做摘要；每次模型回應的 usage 都累加。快取任由供應商處理，cache read 另列。

## 為什麼不用手機 app 的結果

手機部署版本把兩邊 MCP 的圖片都轉成 code mode 的字串結果；模型拿不到圖片。兩次 orders 預檢都失敗，保存為 `pilot-orders-*`，**不是有效的 computer-use 比較樣本**。沒有把這兩次失敗算成任一 server 的能力或 token 優勢。

改用 `direct.mjs` 的相同直接 MCP adapter 後，兩邊都收到圖片且完成任務。這批衡量的是 MCP 配合固定 agent loop 的結果，不是 pi-mobile 手機 app 的端到端效能。

## 三個任務

`fixture.html` 為唯一測試環境。網站與資料庫只在本機執行；合成資料的截圖和工具回傳會送到設定的模型 API。`run.mjs` 保存三個原始中文題目，`direct.mjs` 使用相同題目。

1. **訂單**：篩選待處理訂單、跨頁找名稱相近客戶中的正確訂單、修改收件人／電話／配送／備註、勾選核對、在確認頁輸入訂單編號、儲存。
2. **報銷**：修改草稿用途／部門／申請人，保留日期；下一步修改兩個金額、刪除一列、新增一列；再核對總額、勾單據、真正送出。
3. **專案**：篩選 Pilot、跨頁選取五個任務、批次改狀態；另外修改指定任務的負責人／優先度／日期，保留其他內容以及 Core 全部資料。

這是特製、可自動判分的合成 GUI workload，不是跨網站通用 benchmark。它刻意含有可批次的表單操作，不能推廣成任意 computer-use 工作都會得到同樣比例。

## 每次的流程與判分

- 全新模型對話，相同 system prompt 與對應題目。
- 重載同一 fixture，資料重設到相同 seed；視窗位置大小固定、瀏覽器在前景、從訂單首頁開始。沒有把 DOM、seed 或預期答案提供給 agent。
- 模型只能透過該組 MCP 看螢幕與操作。治具重設及事後判分可以使用 CDP，不能在模型操作期間給它 CDP/DOM 提示。
- 結束後讀取整份實際 state，與預先定義的完整 expected state 比對；不只是相信模型自述完成，也檢查非目標資料完全沒變。
- 保存每次模型 usage、工具參數、工具錯誤、結果文字、圖片 SHA-256／大小及最後 fixture 截圖。公開 trace 不需要模型的 reasoning_content。
- 計時包含模型和 MCP 操作，不包含治具重設與事後截圖；不是 latency 的嚴格公平隔離測量。
- 游標、系統時鐘及服務端快取沒有完全控制；兩邊交錯執行，這些是實驗限制。

## 重複次數與停止規則

- 初步實跑：三題 × 兩組各一次，`direct-pilot-*`，全部保留。
- 追加：三題 × 兩組 × 四次，`confirm-*`；每一輪交替 own-first / upstream-first，共 24 次。
- 合計每題每組五次，共 **30 次有效 GUI 任務嘗試**，不包含手機 adapter 壞掉的兩次預檢。
- 初步實跑上限為 40 次模型回應／300 秒，六次都正常結束，沒有碰到停止上限。為複雜操作留出重試空間，追加組在開始前調成 **80 次／480 秒**；模型不知道該限制。這個差異會在報告中保留。
- 任務失敗不補跑成成功，不根據結果改善 prompt／schema。供應商或基礎設施錯誤另外記錄，不假裝是 server 的 GUI 能力失敗。

## 指標

- 主指標：累計 API `prompt_tokens`，包含 cached_tokens；**不再把 cached_tokens 加上去**。
- 另列 completion_tokens、total_tokens、cached_tokens、prompt_tokens−cached_tokens。
- 成功率與 token 分開報告。全樣本統計保留失敗；另報兩邊都成功的配對比較，不能用「失敗得快」支持省 token 的主張。
- 次要指標：模型回應次數、MCP 呼叫次數、動作步驟數、回傳截圖數與時間。
- 不從 JPEG/PNG 檔案大小推算 vision tokens；不把 token 比例直接宣稱成帳單比例。

## 重跑

1. 啟動 `server.mjs`，以隔離的可見 Chrome profile 打開 `http://127.0.0.1:47881/`，debugging port 9444。
2. 啟動同版本的兩個 MCP server；`direct.mjs` 預設透過 pi-mobile host `/exec` 建立 stdio transport。依環境調整 host／binary 路徑。
3. 設定本機既有 CLIProxyAPI credential 檔；不要把金鑰寫入 repo。
4. 執行 `RUN_PREFIX=your-run REPEATS=5 node direct.mjs`。只量一題可設定 `TASKS=orders`、`expense` 或 `projects`。
5. 對照 `runs/*.json` 中的 actual/expected state、usage 與 trace，不以 answer 文字代替判分。
