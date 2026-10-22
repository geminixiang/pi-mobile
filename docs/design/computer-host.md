# 把電腦交給 pi：pi-host

狀態：第一版（2026-10-23）。在這台 Mac mini（macOS、Tailscale 官網版 app）和 S24 上試過；Linux 還沒有實際裝過。為什麼選這條路，見 [research/connecting-computers.md](../research/connecting-computers.md)：電腦不必打開 SSH（port 22，會聽區域網路），手機上也不必存放金鑰或密碼。

## 使用者要做的事

1. 電腦上已經裝好 Tailscale，並且登入跟手機同一個帳號。
2. 在電腦的終端機執行一次：
   ```sh
   curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh
   ```
   它會下載對應平台的 pi-host（取自最新的 GitHub release），設定成登入時自動啟動（macOS 用 launchd，Linux 用 `systemd --user`），最後印出要在手機上輸入的名稱。
3. 手機：設定 › 電腦 › 輸入那個名稱 › 加入。之後在 Bot 面板的「電腦」選這台。

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
- **daemon 由手機帶過去**：app 本來就附有 pi-env，版本永遠跟 app 一致，pi-host 不用跟著更新。
- **呼叫 Tailscale CLI**：在 PATH 上找 `tailscale`，找不到就用 macOS app 裡的執行檔。那個執行檔要看到 `TERM` 才會當 CLI 用，launchd 不會設 `TERM`，所以 pi-host 自己補上 `TERM=dumb`。

## 手機（`src/agent/sandbox/host.ts`）

- `settings.hosts`：電腦清單（JSON），每台記著 id、名稱、MagicDNS 名稱、os、arch、帳號、家目錄。
- 設定 › 電腦 › 加入：呼叫 `probeHost(名稱)`，等於 `GET /info`。只輸入短名稱也行，因為 Tailscale 的 DNS 會補上 tailnet 網域。
  - 連不到：顯示安裝指令。
  - 回 403：告訴使用者手機和電腦要登入同一個 Tailscale 帳號。
- `HostSandbox`：每次 app 執行時第一次連線，先 `/info`，沒有對應的 daemon 就 `PUT` 上去，再開 `/env` 的 WebSocket，接到 `StreamConnection` 上。
  - 一律是直接模式：工作目錄是家目錄，提示跟 SSH 的直接模式共用 `directDescription`。
  - 刪 Bot 不會刪電腦上的任何檔案。
- `Computers` 裡的 key 是 `host:<id>`。`settings.sandboxMachine` 也可以存某台電腦的 id，當作預設。

## macOS 的隱私權限

pi-host 由 launchd 啟動，所以 macOS 把它當成一個獨立的程式來問權限：

- 第一次讀「桌面」「文件」「下載項目」這類受保護的資料夾，或第一次截圖時，Mac 的螢幕上會跳出「pi-host 想要取用…」。
- 使用者按允許之前，那個指令會卡住，直到逾時。
- 模型的提示已經寫了遇到這種狀況要請使用者去 Mac 上允許。實測時模型的確這樣回覆了。

## 還沒做

- Linux 還沒有實際安裝測試過。
- 一台電腦接了多支手機時，各自連線，互不影響（不像 egress bridge 一次只能接一支）；但還沒測過。
- SSH 機器和 relay 的設定還留著。要不要拿掉，等這條路用一陣子再決定。
- 排程在電腦上執行時，需要電腦開著、Tailscale 連著；手機連不到時的錯誤訊息還沒調整。
