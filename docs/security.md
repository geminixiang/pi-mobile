# 安全模型


| 資料 | 存放位置 |
|---|---|
| Bot、對話、記憶、執行狀態 | WebView 的 IndexedDB，在 app 的私有資料夾裡（未加密，`allowBackup=false`，不會進雲端備份） |
| 模型供應商的 API key 與 ChatGPT 登入、GitHub token、Google、Cloudflare、Azure 憑證 | Android Keystore（`capacitor-secure-storage`） |
| GitHub token、Google、Cloudflare、Azure access token（容器用） | 每次請求時由手機交給電腦上的 egress proxy，不寫進檔案；長期憑證不離開手機 |
| 容器裡的檔案 | 電腦上共用容器的 volume，每個 Bot 一個資料夾；清空資料夾或刪除 Bot 會刪掉它的資料夾 |
| 電腦的連線 | 沒有金鑰或密碼：電腦上的 pi-mobile 只接受同一個 Tailscale 使用者的裝置 |

- **Bot 做事不會先問你**：push、開 PR、改雲端資源、刪資料庫、回覆訊息、改行事曆、建排程、呼叫 MCP 服務，都直接執行。Bot 讀的網頁、通知、email、issue 是別人寫的，裡面的指令可能被照做（提示注入）。所以只給 Bot 你放心讓它用的工具組和權限。
- App 允許明文 HTTP（`network_security_config.xml`），因為自架的模型 gateway 和電腦上的 pi-mobile 都只透過 Tailscale 連線，WireGuard 已經加密。
- Bot 共用一個容器，所以一個 Bot 讀得到其他 Bot 的資料夾；它被要求只寫在自己的資料夾，但這只是提示，不是隔離。
- 「直接」的指令以你的帳號在電腦上執行，沒有 egress proxy，用的是電腦自己的登入。
- 「手機畫面」用 Android 的無障礙服務，Bot 能看到並操作手機上任何 app（開 app、點、滑、打字）。預設關閉，要你自己在 Android 的無障礙設定打開；開了之後，有開這個工具組的 Bot 在回答時才會用，畫面內容（密碼欄除外）會送給模型。不想讓某個 Bot 用，就在 Bot 面板關掉「手機畫面」。
- 手機資料夾的 bash 有 `git` 和 `gh`，可以連 GitHub（只有 GitHub）。GitHub token 在 app 送出請求時才加上，不會出現在 bash 的環境變數、檔案或 git 設定裡；push、開 PR、留言一樣不會先問你。
- 電腦上的 pi-mobile 只聽電腦的 Tailscale 位址（不聽區域網路），每個請求都用 `tailscale whois` 確認是你同一個 Tailscale 帳號的裝置，tagged 裝置和瀏覽器網頁（`Origin`）一律拒絕。所以能進入你 tailnet、又登入你帳號的裝置，都能操作這台電腦：手機遺失時，到 Tailscale 後台移除它。
- 能登入電腦那個帳號的人，可以讀到 egress 的 CA 私鑰，以及正在使用的短效 token。
- 發布版關閉 WebView 遠端除錯。開發版（`build-android.sh`）是開著的：能用 adb 連上手機的人可以操作 app。
- Agent 拿得到你給它的權限：GitHub 建議用只開必要 repo 的 fine-grained token；雲端帳號建議用權限小的專案或訂閱。

## 已知限制

- 只有 Android。iOS 需要 Xcode 和 Apple Team ID，還沒做。
- 容器只實測過 docker（Mac 上的 colima）；podman、nerdctl、x86 電腦還沒測。電腦上的 pi-mobile 只實測過 macOS。
- Sandbox 沒有互動式終端機（PTY），vim、REPL 這類程式不能用。
- `aws` 還沒支援。
- `az` 在 sandbox 裡是 managed identity，所以 `az ad signed-in-user show` 這類「我是誰」的指令不能用；還沒在有訂閱的帳號上測過建立資源。
- 內建供應商只實測過 OpenRouter（直接從手機呼叫）；其他家都確認過允許從手機的 WebView 呼叫（CORS），但還沒用真的 key 測。NVIDIA 不允許，所以沒列。
- 訂閱登入只支援 OpenAI 的 Sign in with ChatGPT（`src/agent/chatgpt.ts`，照 pi-ai 的流程在手機上重做）。Claude Pro／Max、GitHub Copilot 等其他訂閱登入不做。
- 介面只有繁體中文。
- 排程觸發時如果 pi 已經被系統清掉，要點通知才會開始執行，不會自己在背景跑。
- 背景觸發的 run 不能要求新的權限（定位、行事曆），要先在前景用過一次授權。
- 戴耳機觸發時如果 pi 已經被系統清掉，一樣要點通知才會開始，所以不一定能「一戴上就聽到」。
- 螢幕使用時間和數位助理是 Android 的「受限制的設定」：不是從 Play 商店裝的 app，要先在 pi mobile 的應用程式資訊頁按「⋮ › 允許受限制的設定」才能打開。
- 通話紀錄和簡訊在 Google Play 只開放給預設的電話和簡訊 app；pi 是自己安裝的，所以是一般的執行期權限。
- 附件只讀 PDF、Word（docx）、Excel（xlsx）、CSV 和純文字；舊版 doc、xls 和 PowerPoint 不支援。分享單一檔案最大 20 MB。
- 鎖屏時，手機的網路偶爾會短暫中斷，正在跑的 sandbox 指令會失敗；指令已經送到電腦的，錯誤會說結果不明，agent 要先確認再重試。
