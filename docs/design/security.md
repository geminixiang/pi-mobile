# 金鑰與連線的安全

狀態：2026-10-25 檢查 Android 版，修了兩件事（電腦配對、明文 HTTP）。網頁版的存放方式是設計，還沒做。

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
| 頁面注入 | Markdown 不執行 HTML；HTML 檔放在無來源的 sandbox iframe，且只在 bridge 有限定來源時才預覽；Mermaid 會轉義標籤（實測 `<img onerror>`、`<script>`、`javascript:`） |
| 偽造系統廣播 | `HeadphonesReceiver` 雖然對外開放，藍牙連線廣播是受保護的，其他 app 送不出來（實測 `SecurityException`） |
| OAuth 回呼 | MCP 和 ChatGPT 登入都用 32 bytes 隨機 `state` 加 PKCE S256，回呼時核對 `state`；本機回呼 server 只綁 `127.0.0.1` |

## 2026-10-25 修的

### 電腦端要配對（`08258b1`）

Tailscale 證明的是哪台裝置，不是哪個 app。實測 S24 上的 adb shell（uid 2000）拿 `:4790/info` 得到 200，`/exec` 用同一道檢查，所以手機上任何 app 都能以使用者身分在電腦上執行指令。現在電腦端要配對過的金鑰才回應；做法見 [computer-host.md](computer-host.md)。

### 金鑰不走明文 HTTP（`9560c18`）

App 允許 cleartext，因為 tailnet 裡的閘道常是 http。但自訂端點填成區網或公網的 http 位址時，金鑰會在當下的 Wi-Fi 上明文送出。`refuseCleartextSecret`（`src/agent/cleartext.ts`）只讓金鑰走 https，或 http 到 loopback、`*.ts.net`、`100.64.0.0/10`、`fd7a:115c:a1e0::/48`。檢查點：自訂供應商的認證、它的模型清單、網路搜尋、帶 Authorization 的 MCP 請求。沒有金鑰的區網服務（例如 Ollama）照常可用。

## 網頁版（設計，還沒做）

瀏覽器裡沒有「頁面拿得到、注入的腳本拿不到」的地方：從瀏覽器直接呼叫模型時，送出的那一刻金鑰一定在頁面記憶體裡。所以分兩半：

- **使用中**：只能讓腳本進不來。只放在獨立子網域、只用 HTTPS、不載第三方腳本。
- **存放**：Passkey 的 PRF 擴充（Chrome 116、Safari 18、Firefox 135 起；還要看 passkey 管理器支不支援）。用 PRF 導出的金鑰加密，開網頁時按一次指紋解鎖。不支援時退回「不記住金鑰」，每次貼上；金鑰本來就能到供應商後台重拿，沒有救不回來的資料。
- 加密存在 localStorage、用不可匯出的 WebCrypto 金鑰：只擋得住直接翻檔案，不做。
- 想讓金鑰完全不進瀏覽器，就要有東西代為呼叫：雲端代理看得到所有對話，不做；使用者自己的電腦（已經有電腦端）可以，但要先讓電腦端走 HTTPS。

## 還沒處理

- **讀進來的內容誘導模型送出個人資料**：例如網頁要模型把通訊錄放進網址再 `web_fetch`。目前只有排程的防線（guards）。需要另外評估。
- 手機「移除」電腦時會撤銷自己的金鑰（`DELETE /unpair`）；電腦端太舊或連不到時，配對會留在 `~/.pi/mobile/paired.json`，手機會說明。手機遺失時仍要到電腦上刪那一行。
