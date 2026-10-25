# 電腦上的長指令，手機斷線時會怎樣

研究日期：2026-10-26。回答 [t3-lody-paseo-design.md](t3-lody-paseo-design.md) 的 B1：pi-mobile 把工具交給電腦執行，手機的連線斷了，電腦上正在跑的 `npm ci`、gradle、長測試會不會跟著死？要不要讓它活下來？怎麼做？

結論先講：**換網路和鎖屏都不會斷**，實測兩次都完整跑完；會斷的是**超過 30 秒完全沒有網路**，以及 **App 被系統殺掉**。這兩種可以靠電腦端的 `pi-mobile serve` 代為維持 pi-env 的連線、讓手機重新接上來解決，不需要改 pi-env。但先量真實發生率，再決定值不值得做。

## 現在的機制（文件與程式碼）

三層，每一層都會在斷線時結束指令：

1. **pi-env daemon**（Rust，由 npm 套件 `@earendil-works/pi-env` 1.4.0 附帶，手機上傳到電腦）。協定文件寫明：「雙方每 5 秒 ping 一次。daemon 在 30 秒沒收到任何 bytes、或 stdin 結束時，殺掉它啟動的每個 process group 並退出。**所以連線斷掉就會停掉遠端指令。**」客戶端把遺失連線時的請求標成 `{ code: "unknown", lost: true }`，下一個請求再開一個新 daemon；handle 屬於開它的 daemon。[pi-env protocol.md § Liveness]
2. **`pi-mobile serve`**（Go，`host/main.go`）。`/env` 的 WebSocket 一結束，`done()` 取消 context，`endGroup` 對整個 process group 送 SIGTERM、2 秒後 SIGKILL；`/exec` 同樣。這是刻意的：之前只殺 login shell，底下的 npx、node 變成孤兒，實測留了 7 個 `computer-use-mcp`。[design/computer-host.md]
3. **手機的 `StreamConnection`**（`src/agent/sandbox/stream-connection.ts`）。每 5 秒 ping，30 秒沒收到就 teardown；teardown 把在途請求 reject。2026-10-26 起，已送出的請求回「結果不明」，沒送出的回「未送出」。

pi-durable 這一側：工具呼叫是 durable task，意圖先提交再執行；**程序死掉時**，沒有宣告 `replay: "safe"` 的工具不會重跑，模型拿到 `interrupted` 錯誤結果。`bash` 沒有宣告 replay-safe，所以 App 被殺掉再重開，bash 不會自動重跑。[pi-durable README § tools]

容器模式一樣：pi-env 在 `docker exec -i … pi-env serve` 裡跑，`docker exec` 的客戶端程序在電腦上、屬於 `/exec` 那條 WebSocket 的 process group；socket 一斷它就被殺，容器裡的 pi-env stdin 結束，照第 1 點殺掉指令。

## 實驗（S24、Mac mini 容器、App 0.7.0-dev 含 A1–A5 修正）

透過 App 對 Pi-mobile UI Bot 下自然語言，請它只跑一個 bash 指令並原文回報。

| 情境 | 指令 | 操作 | 結果 |
| --- | --- | --- | --- |
| 鎖屏、Doze | `for i in $(seq 1 24); do sleep 10; echo tick $i; done`（240 s） | 送出 8 秒後按電源鍵關螢幕；`dumpsys power` 顯示 `Dozing`；270 秒後查看 | **完整**：24 個 tick 與 `finished` 都回到對話。前景服務（KeepAlive）撐住了 WebView 與 WebSocket |
| Wi‑Fi → 行動網路 → Wi‑Fi | `seq 1 18`（180 s） | 執行中 `svc wifi disable` 70 秒再 `enable` | **完整**：18 個 tick 都回來。電腦上的 pi-env 從頭到尾活著（容器內 PID 20417，`etime` 5 分鐘），表示手機的 WebSocket 經 Tailscale 換到行動網路（`tailscale status` 顯示 S24 經 `49.215.x` 直連）時沒有斷 |

兩次都在工作結束之後、對話閒置時，連線才逾時（`pi-env connection timed out`、`daemon exited`）：沒有工作時 KeepAlive 放手，Chromium 凍結頁面，ping 停了。這不影響工作，下次工具呼叫會重連；但它說明 **B3 的「回到前景時 probe」沒有必要**：閒置時斷掉是預期，工作中沒斷。

副作用：Android 在 Wi‑Fi 關閉時會關掉「無線偵錯」且不自動打開，測試後要在手機上重新開。CDP 在 Doze 且閒置時連不上（頁面凍結），這是量測工具的限制，不是 App 的問題。

沒有測的：行動網路完全收不到（電梯、捷運）超過 30 秒；App 被系統殺掉（低記憶體、使用者滑掉）；電腦休眠。前兩種依第 1、3 層的 30 秒上限，**一定**會中斷。

## 所以問題是什麼

| 情境 | 發生率 | 現在的結果 |
| --- | --- | --- |
| 換網路、鎖屏、Doze | 常見 | 沒事 |
| 沒有網路 > 30 秒 | 通勤時會；在家、在辦公室少 | 指令被殺，工具回「結果不明」；模型要自己判斷 |
| App 被殺 | 偶爾 | 指令被殺；重開後 bash 回 `interrupted`，不重跑 |
| 電腦休眠 | 看設定 | 全部停，與本題無關 |

真正的需求是第二、三列：**使用者在捷運上下了一個 10 分鐘的指令，出站後希望看到結果，而不是「結果不明，請自己檢查」。** 這是 T3／Paseo 的 daemon 天生有的，pi-mobile 沒有。

## 做法

### A. `pi-mobile serve` 代為維持 pi-env，手機重新接上（建議）

電腦端在 `/env` 的 WebSocket 斷掉時**不殺** pi-env，改為：

- 繼續讀 pi-env 的 stdout 進一個有上限的緩衝區（例如 8 MiB；pi-env 自己在 4 MiB 未送出時會讓指令慢下來，所以上限夠用），並代替手機每 5 秒送 ping frame 給 pi-env，它就不會因 30 秒靜默退出。
- 保留一段寬限期（例如 5 分鐘）。寬限期內手機帶同一個 token 來 `GET /env?attach=<token>`，先吐出緩衝區，再接回雙向轉送。超過寬限期、或緩衝區滿了，照現在的方式殺掉 process group。
- `/exec` 的容器 `docker exec` 也一樣處理：它只是 pi-env 的載具。

手機端 `StreamConnection` 在 teardown 時區分「連線掉了」與「daemon 死了」：前者保留 session（pending map、token、frame id），進入 `reattaching` 狀態，用退避重試 attach；接上後 pi-env 的 result frame 會對上原本的 request id，等待中的工具呼叫直接完成。退避中的新請求先排隊，不另開 session。超過寬限期才 teardown，在途請求回「結果不明」。

優點：**不改 pi-env**，協定不變，frame id 本來就由客戶端配；改動集中在 `host/main.go` 和 `stream-connection.ts`，各一個 contract／Go 測試就能蓋住。清理孤兒程序的設計保留，只是晚 5 分鐘。
代價：電腦上多一個緩衝；手機端 session 狀態機多兩個狀態；30 秒的 ping 邏輯要改成「連線層斷了不等於 session 死了」。App 被殺的情況，重開後 pi-durable 不重跑 bash（`interrupted`），所以這條路**只救得了連線中斷，救不了 App 被殺**——除非 bash 宣告 replay-safe 並由 attach 取回同一個 request 的結果，那是第二步。

### B. 上游 pi-env 加 session resume

daemon 在 stdin 結束後保留 N 秒、允許帶 token 重接並重放緩衝的 frame。最乾淨，但 pi-env 是 Earendil Works 的 Rust 套件，pi-mobile 只拿 npm 的二進位；要提 issue／PR、等釋出、再升版。A 做得到同樣效果而且不等人；若上游日後有，A 可以退場。

### C. 電腦端的「工作」端點

`/job/start` 用 `setsid` 跑指令、輸出寫檔；`/job/<id>/stream` 由手機隨時接回。不經過 pi-env，所以也救得了 App 被殺（重開後 bash 重跑時先查有沒有同一把 key 的 job）。但這是另一套執行路徑：環境變數、cwd、容器內外、輸出視窗、取消語意都要再做一次，而且 bash 工具是 pi-durable 的 `createCodingTools()`，要在 `ExecutionEnv.exec` 層攔截。比 A 大很多，只在 A 做完仍不夠時考慮。

### D. 只靠提示

sandbox 描述加一句：預期超過一分鐘的指令用 `nohup … > log 2>&1 &` 再輪詢。零程式碼，今天就能做；但靠模型記得，而且輸出要自己去撈。可以當 A 完成前的過渡，不當解法。

## 做了 A（2026-10-26）

電腦端 `host/held.go`、手機端 `src/agent/sandbox/resumable-socket.ts`，設計寫在 [design/computer-host.md](../design/computer-host.md)。第一版只在偵測到斷線後才替 pi-env 送心跳，S24 實測手機 Tailscale 停掉後 pi-env 30 秒內就死了：手機沒網路時不會送 FIN，電腦不知道連線已斷。改成電腦一律送心跳、並主動 ping 手機偵測斷線之後，再測一次：

| | |
| --- | --- |
| 指令 | 容器內 `for i in $(seq 1 24); do sleep 10; echo tick $i; done`（240 s） |
| 斷線 | 執行 21 秒後 `am force-stop com.tailscale.ipn`，75 秒後重新啟動 |
| 電腦判定斷線 | 19 秒後（10 秒 ping 間隔 + 10 秒逾時） |
| 手機回來 | Tailscale 起來後約 1 秒接上，電腦補送 21 則訊息 |
| 結果 | 24 行 tick 與 `finished` 全部回到對話；pi-env 同一個行程（token 相同）活到最後 |

之後 App 退到背景、工作結束、頁面被凍結時又斷了一次，回到前景 1 秒內接回並補送 5 則；這是預期行為。

## 建議（更新）

1. A 已做。診斷記錄的 `host.resume` 事件（dropped、attached、gave_up）可以看實際發生率與重接次數。
2. 之後再看 App 被殺的情況：bash replay-safe 加上以 request 對回保留的 session，這是 pi-durable 的語意變更，另開題。
4. **B3 不做**：實測顯示工作中的連線撐得住，閒置時斷掉是正常。
5. **B4 等 A**：A 會讓新 App 配舊 host 出現第二個不相容點（第一個是 `/unpair`），到時 `/info` 加 `features`。

## 證據

- `/tmp/pi-container-loop.NAWWhg/evidence/b1-lockscreen-1.json`、`b1-wifi-toggle.json`：兩次實驗的對話結果與連線狀態。
- Mac mini `~/.pi/mobile/pi-mobile.log` 02:46 的 `/info`、`/exec`；`docker exec pim-main ps` 顯示 pi-env 在 Wi‑Fi 切換後仍在。
- pi-env 協定：`node_modules/@earendil-works/pi-env/docs/protocol.md`（1.4.0，§ Liveness、§ Cancellation）。
- pi-durable 工具語意：`node_modules/@earendil-works/pi-durable/README.md`（§ tools：`replay`、`interrupted`）。
- 電腦端：`host/main.go` 的 `env()`、`loginShell()`、`endGroup()`。
