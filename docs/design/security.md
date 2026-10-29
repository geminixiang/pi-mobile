# 金鑰與連線的安全

狀態：2026-10-25 檢查 Android 版，修了兩件事（電腦配對、明文 HTTP）；2026-10-27 檢查電腦連線，修了四件事。網頁版的存放方式是設計，還沒做。

## 威脅

- **手機上其他 app**：沒有 root，但有網路權限，連得到 Tailscale 和本機 port。
- **拿到手機或備份的人**：能複製 app 的資料夾，但拿不到 Keystore 裡的金鑰。
- **讀進來的內容**（網頁、通知、簡訊、MCP 回應）：可能夾帶給模型的指令。金鑰從不進模型的上下文，所以這條路拿不到金鑰；個人資料則可能被送出去，見最後一節。
- **被污染的 npm 套件**：在 app 裡執行，拿得到一切。只能靠版本寫死、`npm audit` 和少用套件。

## Android 上已經做到的

| 項目 | 做法 |
|---|---|
| 金鑰存放 | `@aparajita/capacitor-secure-storage`：每個金鑰一把 Android Keystore 的 AES-GCM 金鑰，密文在 app 私有的 SharedPreferences。沒有綁「解鎖才能用」：背景排程要能用。 |
| 備份 | `allowBackup="false"` |
| 偵錯 | release 關閉 WebView 遠端偵錯（`scripts/release-android.sh` 檢查）；release 不可偵錯，`run-as` 進不去 |
| 模型看不到金鑰 | 供應商金鑰只在請求 header；雲端工具只連固定主機、token 在工具內加上；`gh auth status` 不印 token；容器裡只有佔位值，真的憑證由 egress proxy 向手機要（`docs/architecture.md`） |
| 頁面注入 | Markdown 不執行 HTML；HTML 檔放在無來源的 sandbox iframe，且只在 bridge 有限定來源時才預覽；Mermaid 圖（pele）會轉義標籤（實測 `<img onerror>`、`<script>`），並關掉連結和圖片：`click` 的連結在 WebView 裡會把整個 app 導走 |
| 偽造系統廣播 | `HeadphonesReceiver` 雖然對外開放，藍牙連線廣播是受保護的，其他 app 送不出來（實測 `SecurityException`） |
| OAuth 回呼 | MCP 和 ChatGPT 登入都用 32 bytes 隨機 `state` 加 PKCE S256，回呼時核對 `state`；本機回呼 server 只綁 `127.0.0.1` |
| App 內更新 | 只從 `api.github.com/repos/geminixiang/pi-mobile/releases/latest` 拿版本，APK 經 https 下載到 app 的快取；SHA-256 要等於 GitHub 給的 `digest`，套件名稱和簽章憑證要跟裝著的一樣，才交給 Android 的安裝畫面，安裝前使用者還要按一次確認。SHA-256 和 APK 來自同一個 release，只擋傳輸錯誤；擋冒名的是簽章：Android 本來就不讓不同金鑰的 APK 覆蓋安裝，這裡先檢查，讓錯誤說得清楚 |

## 2026-10-25 修的

### 電腦端要配對（`08258b1`）

Tailscale 證明的是哪台裝置，不是哪個 app。實測 S24 上的 adb shell（uid 2000）拿 `:4790/info` 得到 200，`/exec` 用同一道檢查，所以手機上任何 app 都能以使用者身分在電腦上執行指令。現在電腦端要配對過的金鑰才回應；做法見 [computer-host.md](computer-host.md)。

### 金鑰不走明文 HTTP（`9560c18`）

App 允許 cleartext，因為 tailnet 裡的閘道常是 http。但自訂端點填成區網或公網的 http 位址時，金鑰會在當下的 Wi-Fi 上明文送出。`refuseCleartextSecret`（`src/agent/cleartext.ts`）只讓金鑰走 https，或 http 到 loopback、`*.ts.net`、`100.64.0.0/10`、`fd7a:115c:a1e0::/48`。檢查點：自訂供應商的認證、它的模型清單、網路搜尋、帶 Authorization 的 MCP 請求。沒有金鑰的區網服務（例如 Ollama）照常可用。

## 2026-10-27 檢查電腦連線（已修）

前提照 [computer-host.md](computer-host.md) § 網路與資安：加密和裝置身分交給 Tailscale。這次看的是 Tailscale 擋不到的地方。

### 1. 手機不確認電腦位址在 tailnet 裡（中）

- **現況**：新增電腦時，使用者打的名稱直接拿去組 `http://<名稱>:4790`（`base()`，`src/agent/sandbox/host.ts`），只在 iOS 上擋 IP。`refuseCleartextSecret` 只用在模型供應商和 MCP，沒用在電腦。
- **會怎樣**：填成區網 IP、`mac.local` 或公網名稱時，配對碼、配對金鑰、之後每個指令和輸出都在當下的 Wi-Fi 上明文傳送。而且手機不驗證電腦的身分，只要回應 `/pair` 的就被當成那台電腦：在同一個 Wi-Fi 上冒名的機器會拿到 Bot 的指令、上傳的 pi-env，容器模式下還會拿到 egress 要的短效 token。
- **可能性**：要使用者自己填錯名稱，加上同一個網路上有人等著。不常見，但填 IP 是很自然的錯誤。
- **修了**：所有對電腦的請求都經過 `base()`，套用跟供應商金鑰一樣的規則（`onTailnet`）：只接受 `*.ts.net`、`100.64.0.0/10`、`fd7a:115c:a1e0::/48`，或不含點的 MagicDNS 短名稱。`/info` 回來的 `dnsName` 不另外檢查：之後每次連線一樣經過 `base()`。契約測試確認區網 IP、`mac.local`、`localhost` 在送出前就被拒絕。

### 2. 電腦上的任何程式都能配對，借用 pi-mobile 的 macOS 權限（中）

- **現況**：來源檢查只比對 Tailscale 使用者。從電腦自己連到自己的 Tailscale 位址時，`whois` 回的就是這台電腦，使用者相同，所以會通過（在這台 Mac 上實測：`curl http://100.120.142.97:4790/version` 回 200）。而 `pi-mobile pair` 誰都能執行。
- **會怎樣**：電腦上以你身分執行的任何程式（被污染的 npm 套件、VS Code 擴充、瀏覽器下載的工具），可以自己執行 `pi-mobile pair`、用配對碼換到金鑰，再透過 `/exec` 執行指令。這些指令是 pi-mobile 的子程序，所以會用到你在安裝時給 pi-mobile 的權限：桌面、文件、下載項目、控制 System Events、輔助使用、錄製螢幕。macOS 原本會對這些程式另外詢問這些權限，現在可以繞過。
- **可能性**：要電腦上已經有惡意程式。但 TCC 正是為了這種情況而設的，而 pi-mobile 剛好拿了最敏感的幾項。
- **修了**：手機永遠不會是這台電腦本身，所以來源 IP 是這台電腦自己的 Tailscale 位址時一律拒絕（`anotherDeviceOfTheUser`）。`/version` 改成不檢查來源，`pi-mobile status` 從本機問它。
- **接受的風險**：`install.sh` 把簽章用的 keychain 密碼存在 `~/.pi/mobile/signing/password`（0600）。同一個使用者的程式讀得到，可以用同一個身分簽自己的程式，也會拿到這些權限。要擋就得在簽完後丟掉私鑰，代價是每次更新都要重新允許六項權限，所以不擋，寫在 `docs/security.md`。

### 3. 手機遺失時，電腦端沒有撤銷的指令（低）

- **現況**：配對金鑰不會過期。手機上的金鑰沒有綁「解鎖才能用」（背景排程要用），所以拿到一支沒鎖的手機，就能叫 Bot 操作電腦。要在電腦上撤銷，只能手動編輯 `~/.pi/mobile/paired.json`。
- **已經有的**：到 Tailscale 後台移除那支手機，`whois` 就會失敗，這是最快的方法（`docs/security.md` 有寫）。
- **修了**：`pi-mobile devices` 列出配對過的裝置，`pi-mobile unpair <名稱>|--all` 刪掉。每條連線（保留的 session 和一般的 `/exec`）都登記在開它的金鑰底下（`host/connections.go`）；`pi-mobile serve` 每 5 秒比對 `paired.json`，不在上面的金鑰開著的連線都結束。之前 `DELETE /unpair` 只結束保留的 session，一般的 `/exec`（例如畫面操控的 MCP）會留著。手機的設定頁在電腦回 401 時顯示配對碼欄位。
- **S24 上測時多找到的**：結束保留的 session 時直接結束 pi-env 的程序群組，pi-env 跑的指令（在它們自己的 session 裡）會變成孤兒繼續跑；寬限過期、手機刻意關閉也一樣。現在先關 stdin 讓 pi-env 自己收掉，見 [computer-host.md](computer-host.md)。實測撤銷後指令 1～3 秒內結束。

### 4. 電腦端的 log 和資料夾別人讀得到（低）

- `~/.pi/mobile` 由 `install.sh` 的 `mkdir -p` 建立，是 0755；`pi-mobile.log` 是 0644，裡面有裝置名稱、路徑，以及 pi-env 的 stderr。`paired.json`、`pairing.json`、`daemons/` 本身是 0600／0700，沒有外洩金鑰（實測 log 裡沒有 `key=` 或 `token=`）。
- 只影響多人共用的 Linux，而且多數發行版的家目錄本來就是 0700 或 0750。
- **修了**：`pi-mobile serve` 啟動時把 `~/.pi/mobile` 設成 0700，裡面的檔案就不必一一處理，已經裝好的電腦更新後也一樣。

### Tailscale 近期的漏洞（查到 2026-10-27）

| 來源 | 內容 | 對 pi-mobile |
|---|---|---|
| [Tailscale SSH 調查](https://tailscale.com/ssh-investigation-update)（10-26，還沒出修補版）、[Tailworm 報告](https://tailworm.com/) | 對 v1.104.2 的評估：已授權的 Tailscale SSH 使用者可經 unix socket 轉送以 root 讀寫 socket（High）、`tailscale serve --tcp` 指到 localapi socket、serve 的 h2 競態等。暫時的緩解是在 `tailscaled` 的服務環境設 `TS_SSH_DISABLE_FORWARDING=1` | pi-mobile 不用 Tailscale SSH，也不用 `tailscale serve`。但使用者自己開了 `tailscale set --ssh` 的電腦會受影響，修補版出來要更新 |
| [TS-2026-013](https://tailscale.com/security-bulletins)（10-21） | eMudhra 的八張 TLS 中繼憑證私鑰外洩；v1.104.2 起不信任它們 | 不影響：電腦連線走 WireGuard，不靠 Web PKI。手機和電腦的 Tailscale 仍應更新到 1.104.2 以上（這台 Mac 已是 1.104.2） |
| TS-2026-012（10-13） | libtailscale 的 `tailscale_getremoteaddr` 在負載下會回錯的來源位址 | 不影響：pi-mobile 用系統的 `tailscaled`，不內嵌 libtailscale。但它說明了「依來源位址判斷身分」本身會出錯，這也是配對金鑰要留著的理由 |
| TS-2026-007、TS-2026-011（7 月、8 月） | Services 和 4via6 的封包過濾漏洞，讓 tailnet 上的人連到只聽 loopback 的服務 | 不影響：`pi-mobile serve` 不聽 loopback。這兩個說明 loopback 不能當成安全邊界 |
| TS-2026-004～006、009、010（6～7 月） | Tailscale SSH 的提權與 env 外洩，修在 1.98.9 | 不用 Tailscale SSH，不影響 |

### 看過、不用改的

- **指令注入**：`loginShell` 用位置參數傳 daemon 路徑和 token，token 先比對 `^[0-9a-f]{16,128}$`；容器指令裡的路徑都經過 `shellQuote`。
- **瀏覽器網頁**：帶 `Origin` 的請求只接受 app 的 WebView；`websocket.Accept` 的 `InsecureSkipVerify` 只關掉函式庫自己的 Origin 檢查，`fromOwner` 已經先檢查過。手機上其他 Capacitor app 的 Origin 一樣是 `http://localhost`，所以真正擋住它們的是配對金鑰。
- **配對碼**：6 位數，15 分鐘，錯 5 次作廢，比對用常數時間；手機上其他 app 最多只能讓配對碼提早作廢。
- **金鑰在網址裡**：WebView 的 WebSocket 不能帶標頭；電腦端的 log 只記路徑，手機端的 log 沒有記網址。
- **保留的 session**：綁定開它的那把金鑰；別的金鑰接不回、也頂不掉。
- **`/exec` 等於以你的身分執行任何指令**：這是設計本身；能用它的只有配對過的手機，而 Bot 會照讀進來的內容做事這點，`docs/security.md` 已經寫了。

## 網頁版（設計，還沒做）

瀏覽器裡沒有「頁面拿得到、注入的腳本拿不到」的地方：從瀏覽器直接呼叫模型時，送出的那一刻金鑰一定在頁面記憶體裡。所以分兩半：

- **使用中**：只能讓腳本進不來。只放在獨立子網域、只用 HTTPS、不載第三方腳本。
- **存放**：Passkey 的 PRF 擴充（Chrome 116、Safari 18、Firefox 135 起；還要看 passkey 管理器支不支援）。用 PRF 導出的金鑰加密，開網頁時按一次指紋解鎖。不支援時退回「不記住金鑰」，每次貼上；金鑰本來就能到供應商後台重拿，沒有救不回來的資料。
- 加密存在 localStorage、用不可匯出的 WebCrypto 金鑰：只擋得住直接翻檔案，不做。
- 想讓金鑰完全不進瀏覽器，就要有東西代為呼叫：雲端代理看得到所有對話，不做；使用者自己的電腦（已經有電腦端）可以，但要先讓電腦端走 HTTPS。

## 還沒處理

- **讀進來的內容誘導模型送出個人資料**：例如網頁要模型把通訊錄放進網址再 `web_fetch`。目前只有排程的防線（guards）。需要另外評估。
- 手機「移除」電腦時會撤銷自己的金鑰（`DELETE /unpair`）；電腦端太舊或連不到時，配對會留在 `~/.pi/mobile/paired.json`，手機會說明。手機遺失時在電腦上執行 `pi-mobile unpair <名稱>`。
