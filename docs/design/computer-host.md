# 把電腦交給 pi：pi-host

狀態：2026-10-23 起，這是 pi mobile 連到電腦的唯一方式；之前的 sandbox relay 和 SSH 機器都已移除。在這台 Mac mini（macOS、Tailscale 官網版 app）和 S24 上試過；Linux 還沒有實際裝過。為什麼選這條路，見 [research/connecting-computers.md](../research/connecting-computers.md)：電腦不必打開 SSH（port 22，會聽區域網路），手機上也不必存放金鑰或密碼。

## 使用者要做的事

1. 電腦上已經裝好 Tailscale，並且登入跟手機同一個帳號。
2. 在電腦的終端機執行一次：
   ```sh
   curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh
   ```
   它會下載對應平台的 pi-host，比對 checksum，設定成登入時自動啟動（macOS 用 launchd，Linux 用 `systemd --user`），從這台電腦的 Tailscale 位址確認 pi-host 有回應，最後印出要在手機上輸入的名稱。
   - pi-host 由 `.github/workflows/host.yml` 建置：`host/` 在 main 上有變動時，覆蓋 prerelease `pi-host` 的檔案（4 個平台和 `pi-host.sha256`）。用 prerelease，所以它不會變成 app 的 latest release。
3. 手機：設定 › 電腦 › 輸入那個名稱 › 加入。第一台會成為預設（直接）；電腦上有容器引擎時，按「容器」會先在那裡建好 image（第一次要幾分鐘），之後就能選。每個 Bot 也可以在面板的「電腦」自己選。

移除：執行同一行指令，最後加上 `-s uninstall`。

## pi-host（`host/main.go`）

- **只聽這台電腦的 Tailscale IPv4 位址**，port 4790，不聽 localhost 和區域網路。Tailscale 還沒連上時每 5 秒重試；位址消失就重新綁定。
- **每個請求都要確認來源**：
  - 用 `tailscale whois --json <來源 IP>` 查出對方裝置，跟 `tailscale status` 裡這台電腦的使用者比對，必須是同一個使用者。
  - tagged 裝置（沒有使用者身分）一律拒絕。
  - 帶了 `Origin` 標頭的請求，只接受 pi app 的 WebView（`http://localhost`），避免使用者自己裝置上的瀏覽器網頁來呼叫它。
  - 不需要密碼或金鑰：WireGuard 已經驗證了對方是哪台裝置，所以 tailnet 本身就是認證。Tailscale Serve 和 tsnet 的 app 也是這樣做。
- **端點**：
  - `GET /info`：回傳 os、arch、帳號、家目錄、電腦名稱、MagicDNS 名稱，以及已經有的 daemon。
  - `PUT /daemon/<sha256>`：存入一個 pi-env daemon。內容的 SHA-256 必須跟網址裡的一致，存在 `~/.pi/host/daemons/`。
  - `GET /env?daemon=<sha>&token=<hex>`：WebSocket。在使用者的 login shell 裡、從家目錄執行 `pi-env serve --token`，把 stdin 和 stdout 當成二進位訊息雙向轉送。
  - `GET /exec?command=<sh>`：WebSocket。在 login shell 裡執行一個指令，用來驅動容器引擎：建 image、啟動 `pim-main` 和 egress、在容器裡跑 pi-env，以及 egress 的 `bridge.py`。它沒有比 `/env` 多給任何權限，兩者都是以使用者身分，執行使用者自己裝置要求的指令。
  - `/info` 也回報 login shell 找得到、而且 `info` 答得出來的容器引擎（docker、podman、nerdctl）。
  - `GET /peers`：同一個使用者在 tailnet 上其他的電腦（在線、macOS 或 Linux、沒有 tag），取自 `tailscale status`。Android 不讓其他 app 讀 Tailscale 的裝置清單，所以手機透過已加入的電腦來看。
- **daemon 由手機帶過去**：app 本來就附有 pi-env，版本永遠跟 app 一致，pi-host 不用跟著更新。
- **呼叫 Tailscale CLI**：在 PATH 上找 `tailscale`，找不到就用 macOS app 裡的執行檔。那個執行檔要看到 `TERM` 才會當 CLI 用，launchd 不會設 `TERM`，所以 pi-host 自己補上 `TERM=dumb`。

## 手機（`src/agent/sandbox/host.ts`）

- `settings.hosts`：電腦清單（JSON），每台記著 id、名稱、MagicDNS 名稱、os、arch、帳號、家目錄、容器引擎。id 就是它的 MagicDNS 名稱，所以移除後再加入，Bot 原本的選擇還在。
- 設定 › 電腦：
  - **第一台**：輸入名稱，按「加入」，呼叫 `probeHost(名稱)`，等於 `GET /info`。只輸入短名稱也行，因為 Tailscale 的 DNS 會補上 tailnet 網域。
  - **之後**：手機向已加入的電腦要 `/peers`，再逐台問 `/info`。有回應的列成一行，按「加入」就好；沒回應的列出名稱，下面附安裝指令。輸入名稱的欄位收進「手動輸入」。實測列出 8 台、逐台確認，共 2.9 秒。
  - 連不到：顯示安裝指令。
  - 回 403：告訴使用者手機和電腦要登入同一個 Tailscale 帳號。
- 加入後，第一台電腦成為預設（直接）。有容器引擎的電腦，在設定或 Bot 面板選「容器」都可以：第一次使用時會先建 image（`prepareContainers`，同一次 app 執行裡只做一次，設定、Bot 面板、Bot 本身共用同一個準備動作），建置時顯示進度。設定頁在選中的方式下面寫一句它代表什麼：「直接」不會先問你，「容器」的寫入會先問你。安裝指令可以複製，也可以分享到電腦上（聊天、郵件）。
- `HostSandbox` 有兩種模式：
  - **直接**：每次 app 執行時第一次連線，先 `/info`，沒有對應的 daemon 就 `PUT` 上去，再開 `/env` 的 WebSocket，接到 `StreamConnection` 上。工作目錄是家目錄，提示是 `directDescription`。刪 Bot 不會刪電腦上的任何檔案。
  - **容器**：`ContainerHost`（`container.ts`）透過 `/exec` 驅動容器引擎，跟以前透過 SSH 時一樣：所有 Bot 共用 `pim-main`，各自在 `/workspace/<Bot 資料夾>`；egress proxy 的 `bridge.py` 也跑在一條 `/exec` 上，向手機要 token、請使用者核准寫入。
- `Computers` 裡的 key 是 `<電腦 id>:direct` 或 `<電腦 id>:container`；`settings.computer` 是沒有自己選的 Bot 用的預設，空的就是手機。

## macOS 的隱私權限

pi-host 由 launchd 啟動，所以 macOS 把它當成一個獨立的程式來問權限：

- 讀「桌面」「文件」「下載項目」這類受保護的資料夾，或截圖時，Mac 的螢幕上會跳出「pi-host 想要取用…」。使用者按允許之前，那個指令會卡住，直到逾時。
- 所以 pi-host 一啟動就先讀一次這三個資料夾，讓 macOS 在安裝的當下就問（安裝腳本也先說明了），而不是等手機下指令時才卡住。螢幕錄製只能等第一次截圖時再問。
- 模型的提示寫了：遇到 `Operation not permitted` 或逾時，就請使用者到 Mac 上允許，不要一直重試。實測時模型的確這樣回覆了。
- pi-host 只有 ad-hoc 簽章，macOS 依執行檔辨認它，所以 **pi-host 更新後會再問一次**。要避免這件事，得用 Developer ID 簽章。

## 還沒做

- 第一次使用時能看到的錯誤，在 S24 上都試過：
  - 沒裝 pi-host，或名稱打錯：0.3 秒內顯示「連不到…：電腦要開著、連上 Tailscale，並裝好 pi-host」，下面附安裝指令。
  - pi-host 停了：Bot 回覆連不到這台電腦，請使用者確認；pi-host 回來之後，同一段對話直接就能用。
  - 換了另一個 Tailscale 帳號的手機（回 403）還沒實際試過。

- Linux 還沒有實際安裝測試過。
- 一台電腦接了多支手機時，直接模式各自連線、互不影響；容器模式的 egress bridge 一次只接一支手機，誰拿到 bridge，就是誰的憑證生效。這要改成每支手機各自一條。
- 排程在電腦上執行時，需要電腦開著、Tailscale 連著；手機連不到時的錯誤訊息還沒調整。
