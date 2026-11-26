# 安全模型

| 資料 | 存放位置 |
|---|---|
| Bot、對話、記憶、執行狀態 | WebView 的 IndexedDB，在 app 的私有資料夾裡（未加密，`allowBackup=false`，不會進雲端備份） |
| 模型供應商的 API key 與 ChatGPT 登入、GitHub token、Google、Cloudflare、Azure 憑證 | Android Keystore（`capacitor-secure-storage`；每筆一把 AES-GCM 金鑰，密文在私有 SharedPreferences，不綁解鎖以便背景排程使用） |
| GitHub token、Google、Cloudflare、Azure access token（容器用） | 每次請求時由手機交給電腦上的 egress proxy，不寫進檔案；長期憑證不離開手機 |
| 容器裡的檔案 | 電腦上共用容器的 volume，每個 Bot 一個資料夾；清空資料夾或刪除 Bot 會刪掉它的資料夾 |
| 電腦的連線 | 配對金鑰在 Android Keystore；電腦端只存它的 SHA-256（`~/.pi/mobile/paired.json`），而且只接受同一個 Tailscale 使用者的裝置 |

- **Bot 做事不會先問你**：push、開 PR、改雲端資源、刪資料庫、回覆訊息、改行事曆、建排程、呼叫 MCP 服務，都直接執行。Bot 讀的網頁、通知、email、issue 是別人寫的，裡面的指令可能被照做（提示注入）。所以只給 Bot 你放心讓它用的工具組和權限。
- App 允許明文 HTTP（`network_security_config.xml`），因為自架的模型 gateway 和電腦上的 pi-mobile 都只透過 Tailscale 連線，WireGuard 已經加密。
- Bot 共用一個容器，所以一個 Bot 讀得到其他 Bot 的資料夾；它被要求只寫在自己的資料夾，但這只是提示，不是隔離。
- 「直接」的指令以你的帳號在電腦上執行，沒有 egress proxy，用的是電腦自己的登入。
- 「手機畫面」用 Android 的無障礙服務，Bot 能看到並操作手機上任何 app（開 app、點、滑、打字）。預設關閉，要你自己在 Android 的無障礙設定打開；開了之後，有開這個工具組的 Bot 在回答時才會用，畫面內容（密碼欄除外）會送給模型。不想讓某個 Bot 用，就在 Bot 面板關掉「手機畫面」。跟錢有關的一律由你自己按：畫面上看得到金額時，Bot 只能捲動、等待、讀畫面和返回，其他動作在執行前就被原生程式擋下；密碼欄位 Bot 不打字。這是寫死的規則，不經過模型判斷，也沒有開關（`ScreenMoney.kt`、`ios/AgentScreen/ScreenMoney.swift`；理由見 [research/agent-payments.md](research/agent-payments.md)）。寫成文字的金額（「640 元」）認不出來。不涉及錢的送出、發佈、刪除、預訂另有一關：每一下點擊或送出鍵執行前，由模型判斷「這一下會不會送出東西」和「你有沒有講明內容和對象」；會送出又沒講明，就停在那一下之前，用「送出這次／不要」問你，你按「送出這次」後只放行那一下一次。判斷優先用 classifier，沒有時改問 Bot 自己的主模型；兩者都失敗就當作要問你（`src/phone-screen/confirm.ts`、`src/agent/outside.ts`）。
- 手機資料夾的 bash 有 `git` 和 `gh`，可以連 GitHub（只有 GitHub）。GitHub token 在 app 送出請求時才加上，不會出現在 bash 的環境變數、檔案或 git 設定裡；push、開 PR、留言一樣不會先問你。
- 電腦上的 pi-mobile 只聽電腦的 Tailscale 位址（不聽區域網路），每個請求都用 `tailscale whois` 確認是你同一個 Tailscale 帳號的另一台裝置；這台電腦自己、tagged 裝置和瀏覽器網頁（`Origin`）一律拒絕。除了 `/version` 和 `/pair`，還要帶配對過的金鑰。所以登入你的 Tailscale 帳號、又配對過的手機，都能操作這台電腦。手機遺失時，在電腦上執行 `pi-mobile devices` 和 `pi-mobile unpair <名稱>`（它開著的指令 5 秒內結束），或到 Tailscale 後台移除它。
- 手機只把配對碼、金鑰和指令送到 tailnet 裡的位址（`*.ts.net`、Tailscale IP、MagicDNS 短名稱），填成區網 IP 或 `mac.local` 會直接拒絕。
- 以你的身分在電腦上執行的惡意程式，讀得到 `~/.pi/mobile/signing` 裡的簽章金鑰，能用 pi-mobile 的身分簽自己的程式，拿到你給 pi-mobile 的 macOS 權限（桌面、文件、輔助使用、錄製螢幕）。要擋就得每次更新都重新允許這些權限，所以不擋；這跟給終端機「完整磁碟取用權限」的風險一樣。
- 能登入電腦那個帳號的人，可以讀到 egress 的 CA 私鑰，以及正在使用的短效 token。
- 發布版關閉 WebView 遠端除錯（`scripts/release-android.sh` 檢查，且 `run-as` 進不去）。開發版（`build-android.sh`）是開著的：能用 adb 連上手機的人可以操作 app。
- Agent 拿得到你給它的權限：GitHub 建議用只開必要 repo 的 fine-grained token；雲端帳號建議用權限小的專案或訂閱。

## 已知限制

- iOS 功能範圍比 Android 少（沒有背景長跑、無障礙跨 app 操作、通話簡訊與通知讀取等；細項見 [design/platforms.md](design/platforms.md)）。
- 容器只實測過 docker（Mac 上的 colima）；podman、nerdctl、x86 電腦還沒測。
- Sandbox 沒有互動式終端機（PTY），vim、REPL 這類程式不能用。
- `aws` 還沒支援。
- `az` 在 sandbox 裡是 managed identity，所以 `az ad signed-in-user show` 這類「我是誰」的指令不能用；還沒在有訂閱的帳號上測過建立資源。
- 內建供應商只實測過 OpenRouter（直接從手機呼叫）；其他家都確認過允許從手機的 WebView 呼叫（CORS），但還沒用真的 key 測。NVIDIA 不允許，所以沒列。
- 訂閱登入只支援 OpenAI 的 Sign in with ChatGPT（`src/agent/chatgpt.ts`，照 pi-ai 的流程在手機上重做）。Claude Pro／Max、GitHub Copilot 等其他訂閱登入不做。
- 介面只有繁體中文。
- 排程或戴耳機觸發時，若 pi 已被系統清掉且未授權「顯示在其他應用程式上層」，要點通知才會開始執行。
- 背景觸發的 run 不能要求新的權限（定位、行事曆），要先在前景用過一次授權。
- 螢幕使用時間和數位助理是 Android 的「受限制的設定」：不是從 Play 商店裝的 app，要先在 pi mobile 的應用程式資訊頁按「⋮ › 允許受限制的設定」才能打開。
- 通話紀錄和簡訊在 Google Play 只開放給預設的電話和簡訊 app；pi 是自己安裝的，所以是一般的執行期權限。
- 附件只讀 PDF、Word（docx）、Excel（xlsx）、CSV 和純文字；舊版 doc、xls 和 PowerPoint 不支援。分享單一檔案最大 20 MB。
- 鎖屏時，手機的網路偶爾會短暫中斷，正在跑的 sandbox 指令會失敗；指令已經送到電腦的，錯誤會說結果不明，agent 要先確認再重試。

## 安全設計與邊界

### 威脅模型

- **手機上其他 app**：無 root，但有網路權限，連得到 Tailscale 與本機 port。
- **拿到手機或備份的人**：能複製 app 資料夾，但拿不到 Keystore 裡的金鑰。
- **讀進來的內容**（網頁、通知、簡訊、MCP 回應）：可能夾帶提示注入。金鑰從不進模型上下文（只在請求 header、工具內部或 egress proxy 加上，`gh auth status` 不印 token），所以這條路拿不到金鑰；個人資料外送則尚未完全封堵，見文末。
- **被污染的 npm 套件**：在 app 裡執行，拿得到一切。只能靠版本寫死、`npm audit` 與少用套件。

### 關鍵防護與設計邊界（2026-10-25／10-27 檢查定案）

- **Tailscale 證明裝置、不證明 App**：S24 實測 `adb shell`（uid 2000）能經同一個 VPN 打 `:4790` 拿 200，所以除了 `/version` 與 `/pair`，電腦端一律要求配對金鑰並綁定每條連線與保留 session（`TS-2026-012` 亦印證不可只靠來源位址判身分）。
- **拒絕電腦自己連自己（`anotherDeviceOfTheUser`）**：否則電腦上的惡意程式可自跑 `pi-mobile pair` 換金鑰，經 `/exec` 借用 `pi-mobile serve` 持有的 macOS TCC 權限。
- **只接受 tailnet 位址（`onTailnet`）與明文金鑰閘門（`refuseCleartextSecret`）**：區網 IP、`mac.local`、公網 HTTP 在送出前即拒絕；沒有金鑰的區網服務（如 Ollama）照常放行。
- **CLI Proxy API Server 的 WebSocket 金鑰在網址裡**：WebView 的 WebSocket 不能帶標頭，所以官方路線把金鑰放在 `?key=`（`vite-plugins/pi-ai-codex.ts`）。金鑰只送到同一台、已過明文閘門的主機，跟標頭一樣；差別是網址可能進到代理或伺服器的存取記錄。只用在 `GET /` 自稱 CLI Proxy API Server 的端點。
- **不依賴 Tailscale SSH／Serve 與 loopback**：`TS-2026-004`～`011` 及 2026-10-26 Tailworm 調查顯示 Tailscale SSH 與 loopback 轉送皆曾出洞；`pi-mobile serve` 不用它們且不聽 loopback。
- **Origin 與 WebSocket**：`websocket.Accept` 的 `InsecureSkipVerify` 只關函式庫預設檢查，由 `guard` 擋瀏覽器網頁；真正擋同機其他同 Origin（`http://localhost`）Capacitor App 的是配對金鑰。
- **頁面注入與廣播**：Markdown 不執行 HTML；HTML 預覽放在無來源 sandbox iframe，且只在 bridge 有限定來源時才預覽；Mermaid（pele）轉義標籤（實測 `<img onerror>`、`<script>`）並關掉連結與圖片（`click` 連結在 WebView 會把整個 app 導走）；`HeadphonesReceiver` 雖對外開放，藍牙連線廣播受系統保護，其他 app 送不出來（實測 `SecurityException`）。
- **OAuth 與 App 內更新**：MCP 與 ChatGPT 登入均用 32 bytes 隨機 `state` + PKCE S256、本機回呼只綁 `127.0.0.1`。App 內更新只讀 GitHub latest release、比對 SHA-256（防傳輸錯誤）與套件／簽章憑證（真正防冒名；Android 原生亦禁止異簽覆蓋，先檢查讓錯誤清楚）。

### 網頁版（設計，還沒做）

瀏覽器沒有「頁面拿得到、注入腳本拿不到」的地方，金鑰送出那一刻一定在頁面記憶體裡，因此分兩半：

- **使用中**：只放獨立子網域、只用 HTTPS、不載第三方腳本，讓腳本進不來。
- **存放**：用 Passkey 的 PRF 擴充（Chrome 116、Safari 18、Firefox 135 起，須管理器支援）導出金鑰加密，開頁時按指紋解鎖；不支援就退回「不記住金鑰」、每次貼上（金鑰本來就能去後台重拿）。不做「用不可匯出 WebCrypto 金鑰加密放 localStorage」（只擋直接翻檔）；也不做雲端代理（看得到全部對話）；若要金鑰完全不進瀏覽器，改由使用者自己的電腦端走 HTTPS 代呼叫。

### 還沒處理

- **讀進來的內容誘導模型送出個人資料**：例如網頁要模型把通訊錄放進網址再 `web_fetch`。目前只有排程的防線（guards），需另行評估。
- **離線移除電腦殘留**：手機移除電腦時會呼叫 `DELETE /unpair` 撤銷金鑰；電腦太舊或連不到時配對會留在 `~/.pi/mobile/paired.json`（手機會提示），遺失或需補清時在電腦端執行 `pi-mobile unpair <名稱>`。
