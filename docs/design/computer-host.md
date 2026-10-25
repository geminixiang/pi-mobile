# 把電腦交給 pi：電腦上的 pi-mobile

狀態：2026-10-23 起，這是 pi mobile 連到電腦的唯一方式；之前的 sandbox relay 和 SSH 機器都已移除。在這台 Mac mini（macOS、Tailscale 官網版 app）和 S24 上試過；Linux 還沒有實際裝過。為什麼選這條路，見 [research/connecting-computers.md](../research/connecting-computers.md)：電腦不必打開 SSH（port 22，會聽區域網路），手機上也不必存放金鑰或密碼。

## 使用者要做的事

1. 電腦上已經裝好 Tailscale，並且登入跟手機同一個帳號。
2. 在電腦的終端機執行一次：
   ```sh
   curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh
   ```
   它會下載對應平台的 `pi-mobile`，比對 checksum，設定成登入時自動啟動（macOS 用 launchd，Linux 用 `systemd --user`），用 `pi-mobile status` 從這台電腦的 Tailscale 位址確認它有回應，最後印出要在手機上輸入的名稱和一組配對碼（15 分鐘內有效）。
   - 從**最新的 release** 下載（`releases/latest/download`）。每個 release 由 `.github/workflows/release.yml` 從同一個 commit 建出 APK 和電腦端：4 個平台的 `pi-mobile-<os>-<arch>`、`pi-mobile.icns`，以及涵蓋所有檔案的 `pi-mobile.sha256`。所以手機和電腦的版本永遠成對。
3. 手機：設定 › 電腦 › 輸入那個名稱和配對碼 › 加入。配對碼過期了，在電腦上執行 `pi-mobile pair` 拿一組新的。第一台會成為預設（直接）；電腦上有容器引擎時，按「容器」會先在那裡建好 image（第一次要幾分鐘），之後就能選。每個 Bot 也可以在面板的「電腦」自己選。

移除：執行同一行指令，最後加上 `-s uninstall`。

## 名稱

電腦上的程式就叫 `pi-mobile`，跟 app 同名，用子指令表達角色：`pi-mobile serve`（登入時由 launchd 或 systemd 執行）、`pi-mobile status`、`pi-mobile version`。這是 Rex（`rex server`）、VS Code（`code tunnel`）、Happy（`happy daemon`）、Ollama（`ollama serve`）的做法：一個產品只有一個名字，使用者在電腦上看到的、macOS 問權限時顯示的，都是它。原本叫 pi-host，會被當成樹莓派的東西、看起來像 pi 官方的套件，也看不出它在做什麼。檔案在 `~/.pi/mobile/`，launchd 標籤是 `dev.pi-mobile`，systemd 單元是 `pi-mobile.service`。

## `pi-mobile serve`（`host/main.go`）

- **只聽這台電腦的 Tailscale IPv4 位址**，port 4790，不聽 localhost 和區域網路。Tailscale 還沒連上時每 5 秒重試；位址消失就重新綁定。
- **每個請求都要確認來源**：
  - 用 `tailscale whois --json <來源 IP>` 查出對方裝置，跟 `tailscale status` 裡這台電腦的使用者比對，必須是同一個使用者。
  - tagged 裝置（沒有使用者身分）一律拒絕。
  - 帶了 `Origin` 標頭的請求，只接受 pi app 的 WebView（`http://localhost`），避免使用者自己裝置上的瀏覽器網頁來呼叫它。
  - **還要配對過的金鑰**（2026-10-25 起）。Tailscale 證明的是「哪台裝置」，不是「哪個 app」：手機上任何有網路權限的 app 都經由同一個 VPN 連得到這個 port。實測 S24 上的 adb shell（uid 2000，不是 pi）拿 `/info` 得到 200，`/exec` 用同一道檢查。所以除了 `/version` 和 `/pair`，每個請求都要帶 `key`，而且必須是這台電腦配對時發出去的：
    - `pi-mobile pair` 產生一組 6 位數配對碼，15 分鐘內有效，錯 5 次作廢；`~/.pi/mobile/pairing.json` 只存它的 SHA-256。
    - `POST /pair?code=` 用掉配對碼，回一把 32 bytes 的金鑰；`~/.pi/mobile/paired.json` 只存金鑰的 SHA-256 和配對的裝置名稱。配對碼錯回 422，沒有等待中的配對碼回 410。
    - 金鑰放在 query（`?key=`），因為 WebView 的 WebSocket 不能帶標頭；電腦端的 log 只記路徑。
    - 手機把金鑰存在 Keystore（`host.<id>.key`），不放在 `settings.hosts`。
    - 撤銷：手機「移除」這台電腦時會送 `DELETE /unpair`（帶自己的金鑰），電腦端只刪掉那一把；連不到或電腦端太舊（沒有這個端點）時手機照樣移除，並說明配對還留在電腦上。手動撤銷：刪掉 `~/.pi/mobile/paired.json` 裡那一行（或整個檔案），再重新配對。
- **端點**：
  - `GET /version`：只回版本，不用金鑰；`pi-mobile status` 和手機找 peers 時用它判斷有沒有裝。
  - `POST /pair?code=<6 位數>`：見上面。
  - `GET /info`：回傳 os、arch、帳號、家目錄、電腦名稱、MagicDNS 名稱，以及已經有的 daemon。
  - `PUT /daemon/<sha256>`：存入一個 pi-env daemon。內容的 SHA-256 必須跟網址裡的一致，存在 `~/.pi/mobile/daemons/`。
  - `GET /env?daemon=<sha>&token=<hex>`：WebSocket。在使用者的 login shell 裡、從家目錄執行 `pi-env serve --token`，把 stdin 和 stdout 當成二進位訊息雙向轉送。
  - `GET /exec?command=<sh>`：WebSocket。在 login shell 裡執行一個指令，用來驅動容器引擎：建 image、啟動 `pim-main` 和 egress、在容器裡跑 pi-env，以及 egress 的 `bridge.py`。它沒有比 `/env` 多給任何權限，兩者都是以使用者身分，執行使用者自己裝置要求的指令。
  - `/info` 也回報 login shell 找得到、而且 `info` 答得出來的容器引擎（docker、podman、nerdctl）。
  - `DELETE /unpair`：撤銷呼叫者自己的金鑰，回 204；金鑰不在清單上回 404。
  - `GET /peers`：同一個使用者在 tailnet 上其他的電腦（在線、macOS 或 Linux、沒有 tag），取自 `tailscale status`。Android 不讓其他 app 讀 Tailscale 的裝置清單，所以手機透過已加入的電腦來看。
- **daemon 由手機帶過去**：app 本來就附有 pi-env，版本永遠跟 app 一致，電腦上的 pi-mobile 不用跟著更新。
- **呼叫 Tailscale CLI**：在 PATH 上找 `tailscale`，找不到就用 macOS app 裡的執行檔。那個執行檔從 launchd 啟動時不會自己當 CLI 用，照 Tailscale 文件設 `TAILSCALE_BE_CLI=1`（`docs/research/tailscale.md`）。

- **手機斷線時，pi-env 和它跑的指令留著等手機回來**（2026-10-26 起）。`/env` 和帶 `session=<token>` 的 `/exec` 是「保留的 session」：
  - 電腦端自己每 5 秒對 pi-env 的 stdin 送一個 ping frame，pi-env 的存活不再依賴手機的 ping 送得到（手機沒網路時不會送 FIN，電腦以為還連著，pi-env 卻會在 30 秒靜默後退出——第一版就是這樣死的）。
  - 電腦端每 10 秒對手機的 WebSocket 送 ping，10 秒沒 pong 就算斷線，開始 5 分鐘的寬限；寬限過了才照舊 SIGTERM 整個 process group。
  - 送給手機的每則訊息都編號、留在一個 8 MiB 的環裡；手機帶 `attach=<token>&received=<已收到幾則>` 回來，電腦先回 `{"received":N}` 說自己收到幾則，再補送手機沒收到的；手機也補送電腦沒收到的。`StreamConnection` 的請求 id 不變，所以斷線前送出的 `exec` 在接上後直接拿到結果。
  - 手機端（`resumable-socket.ts`）以 1、2、4、8、15 秒退避重試 4.5 分鐘；電腦回 `no such session`（寬限過了或 pi-env 已退出）或 `too far behind to resume`（環滿了）就放棄，工具回「結果不明」。手機 30 秒沒收到 bytes 也走同一條重接的路，不再直接 teardown。
  - 面板的電腦狀態在這段期間顯示「重新連線中」。
  - S24 實測：容器裡 240 秒的指令執行中，把手機的 Tailscale 強制停止 75 秒再啟動，電腦 19 秒後判定斷線，手機回來 1 秒內接上並補送 21 則訊息，24 行輸出一行不少地回到對話。
- **連線結束，它開的程序也結束**：`/exec` 和 `/env` 的指令各自是一個程序群組（`Setpgid`）。手機的連線斷了，整個群組先收到 SIGTERM，2 秒後 SIGKILL。以前只殺掉 login shell，它底下的 npx、node 會變成孤兒一直留著（實測留了 7 個 computer-use-mcp）。`/exec` 的 shell 自己結束時，留在群組裡的也一起結束；還佔著輸出的程序最多等 5 秒（`WaitDelay`）。`host/main_test.go` 測這兩件事。

## 手機（`src/agent/sandbox/host.ts`）

- `settings.hosts`：電腦清單（JSON），每台記著 id、名稱、MagicDNS 名稱、os、arch、帳號、家目錄、容器引擎。id 就是它的 MagicDNS 名稱，所以移除後再加入，Bot 原本的選擇還在。
- 設定 › 電腦：
  - **第一台**：輸入名稱和配對碼，按「加入」：先 `pairHost` 換到金鑰，再 `probeHost`（`GET /info`）。只輸入短名稱也行，因為 Tailscale 的 DNS 會補上 tailnet 網域。
  - **之後**：手機向已加入的電腦要 `/peers`，再逐台問 `/version`。有裝的列成一行，輸入那台的配對碼按「加入」；沒回應的列出名稱，下面附安裝指令。輸入名稱的欄位收進「手動輸入」。實測列出 8 台、逐台確認，共 2.9 秒。
  - 連不到：顯示安裝指令。
  - 回 403：告訴使用者手機和電腦要登入同一個 Tailscale 帳號。
  - 回 401（沒有金鑰或金鑰不對）：告訴使用者在那台電腦執行 `pi-mobile pair`。在這次改版之前加入的電腦沒有金鑰，列表上直接顯示配對碼欄位。
- 加入後，第一台電腦成為預設（直接）。有容器引擎的電腦，在設定或 Bot 面板選「容器」都可以：第一次使用時會先建 image（`prepareContainers`，同一次 app 執行裡只做一次，設定、Bot 面板、Bot 本身共用同一個準備動作），建置時顯示進度。準備只由三件事啟動：使用者在設定或面板選了容器、Bot 第一次用到它、面板上的重試；打開面板或冷啟動只會顯示已經在進行的準備，不會自己開始（2026-10-26 之前面板一掛載就準備，冷啟動時手機還沒做任何事就先對電腦跑了 12 個 `/exec`）。egress 的 bridge 也一樣，在 Bot 第一次用到容器時才開。設定頁在選中的方式下面寫一句它代表什麼：「直接」用使用者的身分操作，「容器」的憑證留在手機上。安裝指令可以複製，也可以分享到電腦上（聊天、郵件）。
- `HostSandbox` 有兩種模式：
  - **直接**：每次 app 執行時第一次連線，先 `/info`，沒有對應的 daemon 就 `PUT` 上去，再開 `/env` 的 WebSocket，接到 `StreamConnection` 上。工作目錄是家目錄，提示是 `directDescription`。刪 Bot 不會刪電腦上的任何檔案。
  - **容器**：`ContainerHost`（`container.ts`）透過 `/exec` 驅動容器引擎，跟以前透過 SSH 時一樣：所有 Bot 共用 `pim-main`，各自在 `/workspace/<Bot 資料夾>`；egress proxy 的 `bridge.py` 也跑在一條 `/exec` 上，向手機要 token。
- Bot 面板的「電腦」區塊顯示這台電腦的連線狀態（連線中、已連線、幾點幾分連線中斷：原因），由 `StreamConnection` 的事件導出，不輪詢；它說的是上一條連線的事，不代表下一個指令一定成功或失敗。
- 指令送到電腦之後連線才斷，工具回的錯誤會寫明「the request had been sent, so its outcome is unknown: check before retrying」；還沒送出就斷的寫「before the request was sent」。模型據此決定要不要重跑有副作用的指令（push、開 PR）。
- `Workplaces` 裡的 key 是 `<電腦 id>:direct` 或 `<電腦 id>:container`；`settings.computer` 是沒有自己選的 Bot 用的預設，空的就是手機。

## 畫面操控（`pi-mobile mcp computer`，`host/computer.go`）

- 一個 stdio 的 MCP 服務，手機透過 `/exec` 啟動 `pi-mobile mcp computer`。`/exec` 的 PATH 最前面是 pi-mobile 自己的資料夾，所以不用寫完整路徑。
- 兩個工具：`screenshot`（唯讀）和 `act`（一次多個步驟，做完回傳新截圖）。截圖附上前景 app、視窗標題和游標位置。
- **有電腦就有這組工具**：手機上是內建的工具組「電腦畫面」（`src/agent/tools/computer.ts`，`read_screen`、`use_screen`），需要時載入，每台電腦一個連線。Bot 在手機上時這組不可用，也不會列在需要時載入的清單裡。不用另外加 MCP 服務。
- macOS 用 `screencapture` 截圖，用 purego 呼叫 Quartz 事件和輔助使用 API，不用 cgo。權限算在 `pi-mobile serve` 頭上，不用另外授權。Linux 還沒做。
- **它開的 app 由它收掉，不靠模型**：第一次呼叫時記下正在跑的 app（`lsappinfo list` 裡的 Foreground，約 35 毫秒），每次呼叫後記下新出現的。session 結束時，用 SIGTERM 結束這些 app（不問要不要存檔），1.5 秒後還在的就強制結束。原本就開著的 app 不動，即使 Bot 在裡面開了新視窗。session 在三種情況結束：最後一次呼叫後 2 分鐘、手機斷線（stdin 結束）、收到 SIGTERM（serve 結束整個程序群組時）。三種都在 Mac mini 上實測過。
- 為什麼這樣設計、和 computer-use-mcp 的比較，見 [research/computer-use-mcp-eval.md](../research/computer-use-mcp-eval.md)。

## macOS 的隱私權限

macOS 在程式讀「桌面」「文件」「下載項目」、用 osascript 控制別的 app、或錄製螢幕之前，會在 Mac 的螢幕上問使用者。它把手機下的指令算在 `pi-mobile serve` 頭上（launchd 啟動的程式），所以那個指令會卡在詢問上，直到逾時，而這時通常沒有人在電腦前。

所以權限在安裝的那一次全部問完：

- **它是一個 app**：`~/Applications/pi-mobile.app`（bundle id `dev.pi-mobile`，有 Pi 的圖示、`LSUIElement` 不出現在 Dock）。launchd 執行 app 裡的程式，plist 填了 `AssociatedBundleIdentifiers`，所以權限詢問和系統設定的列表都顯示 pi-mobile 的名稱和圖示。`~/.pi/mobile/bin/pi-mobile` 是指向它的連結。圖示由 `scripts/make-icons.py` 產生（`host/macos/pi-mobile.icns`），隨 binary 放在 release。
- **固定的簽章**：安裝腳本第一次執行時，在 `~/.pi/mobile/signing/` 建一個自己的鑰匙圈和一張自簽的程式碼簽章憑證「pi-mobile (local)」，密碼存在旁邊，所以簽章不會跳出詢問；不碰登入鑰匙圈，也不加進鑰匙圈的搜尋清單。之後每次更新都用同一張憑證簽，DR 是 `identifier "dev.pi-mobile" and certificate leaf = H"…"`，macOS 就把新版認成同一個 app（`docs/research/macos-automation.md`）。移除時連同憑證一起刪掉。
- `pi-mobile serve` 一啟動，就依序碰一次：讀桌面、文件、下載項目，用 osascript 問 System Events，**向系統要輔助使用**（`AXIsProcessTrustedWithOptions` 加上詢問，最多等 3 分鐘），**要錄製螢幕**（`CGRequestScreenCaptureAccess`）再截一張螢幕。主動要，pi-mobile 才會出現在設定的列表裡，不用使用者按「+」。macOS 一個接一個問；已經允許的直接通過，不會再問。
- 每一項的結果寫進 `~/.pi/mobile/permissions.json`，`pi-mobile status` 會列出 granted、denied 或 waiting。
- 安裝腳本跟著 serve 一項一項走：等到每一項有結果就印一行 ✓，等太久的印出要做什麼；輔助使用等 20 秒還沒開就直接打開那一頁設定。最後列出沒拿到的項目和設定的位置。`pi-mobile status` 在服務剛重啟、還沒開始聽時，會等它最多 15 秒。
- 模型的提示也寫了：遇到 `Operation not permitted` 或逾時，就請使用者到 Mac 上允許，不要一直重試。
- 錄製螢幕跟其他項目不同：要在系統設定裡打開，而且要重新啟動的程式才看得到。所以沒拿到時，安裝腳本會直接打開那一頁設定，等使用者按 Enter，再重新啟動 `pi-mobile serve` 確認一次。
- 打開之後，macOS 還會另外問一次「pi-mobile 正在要求略過系統私密視窗選擇器並直接取用你的畫面和音訊」，要再按一次「允許」。這是 macOS Sequoia 之後所有直接截取螢幕的程式都會遇到的確認，**每個月會再問一次**（[TechSmith 的說明](https://support.techsmith.com/hc/en-us/articles/30302332343693)），一般 app 無法略過。`pi-mobile serve` 每次啟動（通常是登入時）都會截圖檢查，所以到期後的詢問多半在使用者剛登入、人在電腦前時出現。允許後重新啟動 serve，不會再問。
- 控制其他 app（Finder、Safari、音樂）是每個 app 各問一次，沒辦法事先問完；安裝時只問最常用的 System Events。

## 還沒做

- 第一次使用時能看到的錯誤，在 S24 上都試過：
  - 電腦上沒裝 pi-mobile，或名稱打錯：0.3 秒內顯示「連不到…：電腦要開著、連上 Tailscale，並裝好 pi-mobile」，下面附安裝指令。
  - 電腦上的 pi-mobile 停了：Bot 回覆連不到這台電腦，請使用者確認；電腦上的 pi-mobile 回來之後，同一段對話直接就能用。
  - 換了另一個 Tailscale 帳號的手機（回 403）還沒實際試過。

- Linux 還沒有實際安裝測試過。
- 一台電腦接了多支手機時，直接模式各自連線、互不影響；容器模式的 egress bridge 一次只接一支手機，誰拿到 bridge，就是誰的憑證生效。這要改成每支手機各自一條。
- 排程在電腦上執行時，需要電腦開著、Tailscale 連著；手機連不到時的錯誤訊息還沒調整。
- App 被系統殺掉時，保留的 session 等不到手機回來（新的 App 行程會開新的 session），5 分鐘後被收掉；pi-durable 的 bash 沒有宣告 replay-safe，重開後不會重跑。要接回同一個指令，要先讓 bash 的結果能以 request 對回，另開題。
