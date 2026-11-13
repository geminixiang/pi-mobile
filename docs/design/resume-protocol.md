# 斷線重接協定：狀態與模型

手機和電腦之間每條「保留的 session」（`/env`、帶 `session=` 的 `/exec`）走同一個重接協定，見 [computer-host.md](computer-host.md) § 保留的 session。這份文件寫兩件程式碼說不清的事：兩邊各自的連線狀態長什麼樣，以及怎麼確認協定本身對。

## 協定

- 兩邊各自替送出的訊息編號、留一份補送用的記錄：手機留 4 MiB（`resumable-socket.ts` 的 `Outbox`），電腦留 8 MiB（`host/held_link.go` 的 `outbox`）；各自數收到幾則（`received`）。
- 斷線後手機帶 `attach=<token>&received=<手機收到幾則>` 回來。電腦在鎖裡一次做完：先回 `{"received":N}`（電腦收到幾則），再補送手機缺的。手機收到 N 後補送電腦缺的。
- 任何一邊缺的比對方留的還多，就以名字結束：電腦回 `too far behind to resume`，手機說 `missing more than this phone kept`。電腦已放手時回 `no such session`。手機有網路卻 4.5 分鐘連不上就放棄（`gave up`）。這四個加上指令正常結束（`exit`），是一個 session 僅有的結局。
- 手機放棄的時間要比電腦保留的短：`RESUME_LIMIT_MS`（4.5 分鐘）< `host/protocol.json` 的 `holdMinutes`（15 分鐘），`test/contracts/resume.ts` 檢查。

## 兩邊的狀態

每條連線只有一個欄位放狀態，轉換是純函式，副作用由轉換回傳、外殼執行。

| | 狀態 | 轉換 | 外殼 |
|---|---|---|---|
| 電腦 `host/held_link.go` | `attached{conn}`／`away{until}`／`exited{until, reason}`（手機不在時指令結束了，輸出等手機來拿）／`finished` | `onAttach`、`onDrop`、`onExit`、`onKill`、`onExpire`，回傳下一個狀態和 `closeLink`、`replay`、`release`、`stopCommand` | `host/held.go` 的 `held.apply`；寬限計時器只有一個，依狀態的 `until` 重設，過期的觸發由 `onExpire` 比對時間後忽略 |
| 手機 `src/agent/sandbox/resumable-link.ts` | `opening`／`up{socket}`／`dialing`／`resuming{socket}`（等電腦的 `{"received":N}`）／`waiting{delay}`／`offline`／`closed`；離線預算 `Budget` 只在沒接上的狀態裡 | `step(state, event, world, rules)`，`world` 是現在時間、有沒有網路、手機記錄從第幾則留起 | `resumable-socket.ts` 的 `ResumableSocket`；重試計時器在每次換狀態時清掉，進入 `waiting` 才設 |
| 手機 daemon `src/agent/sandbox/daemon-state.ts` | `opening{queued}`／`open{stream, line}`／`ended`；讀取端 `greeting`（等 `PI-ENV <token>`）／`framed` | `daemonStep`、`read` | `phone-connection.ts` 的 `DaemonProcess`；替 daemon 送 ping 的計時器只在 `line` 斷著時跑 |

以前的寫法是一群布林和可有可無的欄位（電腦端 `link` 加 `ended *string`，手機端 `#synced`、`#held`、`#need`、`#unreachableMs`、`#onlineSince`、`#lastMessage` 和 `#open` 裡的 `awaitingResume`），要靠每個呼叫的地方手動維持一致。轉換的測試：`host/held_link_test.go`、`test/contracts/resumable-link.ts`、`test/contracts/daemon-state.ts`，每個轉換和每個不該有作用的事件各一條。

## 模型（`test/resume-model.ts`）

窮舉所有交錯的模型檢查器，`npm run check` 會跑（約 1.5 秒）。單獨跑：

```sh
node --import ./test/vite-imports.js test/resume-model.ts
```

模型裡有：

- 手機寫 3 則輸入、指令寫 3 則輸出再加結束；手機留 2 則、電腦留 2 則（小到每個以名字結束的路都走得到）。
- 每條連線兩個方向各一個 FIFO 佇列；任何時候都可以斷（最多 3 次），斷了之後還在路上的訊息可能到、也可能整段不見；兩邊各自在任意時間才發現斷了。
- 手機重接最多 4 次；網路可以斷兩次再回來；時間以分鐘走，`holdMinutes` 讀 `host/protocol.json`，手機的上限讀 `RESUME_LIMIT_MS`（無條件進位到分鐘）。手機發現斷線前、電腦發現斷線前，時間不往前走（手機 20 秒沒訊息就重接，電腦 20 秒沒 pong 就算斷）。
- 電腦處理 attach 是一步（在鎖裡），手機補送是收到 `{"received":N}` 之後的另一步。

檢查的性質：

1. 指令的 stdin 收到的輸入、手機收到的輸出，每一則都恰好一次且照順序（每一步都檢查）。
2. 沒有下一步可走的狀態裡，手機一定已經結束，而且結束的理由是上面五個之一；理由是 `exit` 時，輸入和輸出都完整送到了。
3. 電腦因寬限到期放手時，手機要嘛已經放棄，要嘛這段期間沒網路過（沒網路不算手機的時間，這時接回會拿到 `no such session`，是有名字的結局）。
4. 五個結局在模型裡都走得到，否則模型沒檢查到那條路，檢查失敗。

模型也確認自己抓得到錯：把「電腦依計數的順序寫進 stdin」關掉（2026-11-14 前的 `held.go`），或讓手機試得比電腦保留得久，它都要找到反例，找不到就失敗。

模型沒有的：位元組大小（記錄的上限用則數代替）、pi-env 自己的 ping、`/exec` 和 `/env` 的差別、配對被刪除（`onKill` 的另一個來源，轉換測試有）。

## 2026-11-14 的 flake

`host/held_chaos_test.go` 偶爾失敗，一行輸出不見、後面一行重複。原因在測試：測試裡的手機用帶逾時的 `conn.Read(ctx)` 等輸出，`coder/websocket` 在 context 到期時可能已經把一則訊息讀完、卻仍回傳 context 的錯誤，連線還能繼續用。測試以為「沒收到」而沒有計數，下次接回時報的 `received` 少一，電腦就從少一的地方補送：被吞掉的那則不見、後面的重複。手機的 WebView WebSocket 一則一則整個交出來，沒有這個問題。現在測試的手機用一個 goroutine 一直讀，逾時只是不再等，不會取消讀取。

同時找到 `held.go` 的一個真的問題：電腦先在鎖裡把輸入計數，放開鎖之後才寫進 stdin。舊連線剛計數、還沒寫的那一則，可能被新連線補送後的輸入搶先寫進去，順序就錯了。現在計數和寫入在同一把 `input` 鎖裡，`TestInputCountedOnADroppedLinkReachesStdinBeforeInputFromTheNextLink` 在舊程式上失敗。這個在混亂測試裡 3000 次都沒出現過，模型兩步就找到。
