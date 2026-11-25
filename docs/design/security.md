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

## 關鍵安全邊界與取捨（2026-10-25／10-27 檢查定案）

已實作的細節在程式碼與 [docs/security.md](../security.md)；這裡只留容易被改壞的原因與接受的風險：

- **Tailscale 證明裝置、不證明 App**：S24 實測 `adb shell`（uid 2000）能經同一個 VPN 打 `:4790` 拿 200，所以除了 `/version` 與 `/pair`，電腦端一律要求配對金鑰（存在 Keystore，電腦只存 SHA-256，並綁定每條連線與保留 session；`TS-2026-012` 也印證不可只靠來源位址判斷身分）。
- **拒絕電腦自己連自己（`anotherDeviceOfTheUser`）**：否則電腦上的惡意程式可自跑 `pi-mobile pair` 換金鑰，經 `/exec` 借用 `pi-mobile serve` 持有的 macOS TCC 權限（桌面、文件、輔助使用、錄製螢幕）。
- **只接受 tailnet 位址（`onTailnet`）與明文金鑰閘門（`refuseCleartextSecret`）**：配對與指令皆明文 HTTP，加密靠 Tailscale WireGuard；區網 IP、`mac.local`、公網 HTTP 在送出前即拒絕。沒有金鑰的區網服務（如 Ollama）照常放行。
- **接受的風險**：`~/.pi/mobile/signing/password`（0600）同使用者可讀，惡意程式可簽出同 DR 的程式繼承 macOS 權限；丟掉私鑰會讓每次更新都要重開六項權限，故接受此風險。
- **Origin 檢查**：`websocket.Accept` 的 `InsecureSkipVerify` 只關函式庫預設檢查，由 `guard` 擋瀏覽器網頁；真正擋手機上其他同 Origin（`http://localhost`）Capacitor App 的是配對金鑰。
- **不依賴 Tailscale SSH／Serve 與 loopback**：`TS-2026-004`～`011` 及 2026-10-26 Tailworm 調查顯示 Tailscale SSH 與 loopback 轉送皆曾出洞；`pi-mobile serve` 不用它們且不聽 loopback。
- **App 內更新**：SHA-256 來自同一個 GitHub release，只防傳輸錯誤；真正防冒名的是簽章比對（Android 原生亦禁止異簽覆蓋）。

## 網頁版（設計，還沒做）

瀏覽器裡沒有「頁面拿得到、注入的腳本拿不到」的地方：從瀏覽器直接呼叫模型時，送出的那一刻金鑰一定在頁面記憶體裡。所以分兩半：

- **使用中**：只能讓腳本進不來。只放在獨立子網域、只用 HTTPS、不載第三方腳本。
- **存放**：Passkey 的 PRF 擴充（Chrome 116、Safari 18、Firefox 135 起；還要看 passkey 管理器支不支援）。用 PRF 導出的金鑰加密，開網頁時按一次指紋解鎖。不支援時退回「不記住金鑰」，每次貼上；金鑰本來就能到供應商後台重拿，沒有救不回來的資料。
- 加密存在 localStorage、用不可匯出的 WebCrypto 金鑰：只擋得住直接翻檔案，不做。
- 想讓金鑰完全不進瀏覽器，就要有東西代為呼叫：雲端代理看得到所有對話，不做；使用者自己的電腦（已經有電腦端）可以，但要先讓電腦端走 HTTPS。

## 還沒處理

- **讀進來的內容誘導模型送出個人資料**：例如網頁要模型把通訊錄放進網址再 `web_fetch`。目前只有排程的防線（guards）。需要另外評估。
- 手機「移除」電腦時會撤銷自己的金鑰（`DELETE /unpair`）；電腦端太舊或連不到時，配對會留在 `~/.pi/mobile/paired.json`，手機會說明。手機遺失時在電腦上執行 `pi-mobile unpair <名稱>`。
