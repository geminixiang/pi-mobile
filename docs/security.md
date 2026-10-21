# 安全模型


| 資料 | 存放位置 |
|---|---|
| Bot、對話、記憶、執行狀態 | 手機的 SQLite（未加密，`allowBackup=false`，不會進雲端備份） |
| 模型服務 key、GitHub token、relay token、Google、Cloudflare、Azure 憑證 | Android Keystore（`capacitor-secure-storage`） |
| GitHub token（sandbox 用） | 手機連線期間加 10 分鐘，放在 relay 的記憶體 |
| Google、Cloudflare、Azure access token | relay 的記憶體，到期為止；長期憑證不離開手機 |
| Sandbox 檔案 | 主機上共用容器的 volume，每個 Bot 一個資料夾；清空資料夾或刪除 Bot 會刪掉它的資料夾 |
| 手機的 SSH 私鑰 | App 的私有目錄（`filesDir/ssh`），不離開手機 |

- 所有 GitHub、Google Cloud、Cloudflare、Azure 的寫入都要在手機上核准，包括 sandbox 裡的 git、gh、gcloud、cf、wrangler、az，以及手機上的 `github_api` 工具。
- App 允許明文 HTTP（`network_security_config.xml`），因為自架的模型 gateway 和 relay 通常只透過 Tailscale 連線。
- Bot 共用一個容器，所以一個 Bot 讀得到其他 Bot 的資料夾；它被要求只寫在自己的資料夾，但這只是提示，不是隔離。
- 直接模式（主機沒有容器引擎）的指令以你的帳號在主機上執行，沒有 egress proxy，也沒有寫入核准。
- 能登入 sandbox 主機那個帳號的人，可以讀到 relay 記憶體裡的 token，以及 egress 的 CA 私鑰。
- Relay 用一個 token 驗證手機，用明文 WebSocket 傳輸；請只在 Tailscale 這類加密的私人網路上使用，不要把 relay 開到公網。
- 發布版關閉 WebView 遠端除錯。開發版（`build-android.sh`）是開著的：能用 adb 連上手機的人可以操作 app。
- Agent 拿得到你給它的權限：GitHub 建議用只開必要 repo 的 fine-grained token；雲端帳號建議用權限小的專案或訂閱。

## 已知限制

- 只有 Android。iOS 需要 Xcode 和 Apple Team ID，還沒做。
- Relay 的 sandbox image 只有 arm64（打包 `pi-env-linux-arm64`）。SSH 容器模式只實測過 docker（Mac 上的 colima）；podman、x86 主機還沒測。
- Sandbox 沒有互動式終端機（PTY），vim、REPL 這類程式不能用。
- `aws` 還沒支援。
- `az` 在 sandbox 裡是 managed identity，所以 `az ad signed-in-user show` 這類「我是誰」的指令不能用；還沒在有訂閱的帳號上測過建立資源。
- 只用自架的 gateway 實測過，直連 OpenAI、Anthropic 官方 API 還沒測。
- 介面只有繁體中文。
- 排程觸發時如果 pi 已經被系統清掉，要點通知才會開始執行，不會自己在背景跑。
- 背景觸發的 run 不能要求新的權限（定位、行事曆），要先在前景用過一次授權。
- 戴耳機觸發時如果 pi 已經被系統清掉，一樣要點通知才會開始，所以不一定能「一戴上就聽到」。
- 分享給 pi 目前只收文字、連結和一張圖片。
- 鎖屏時，手機的網路偶爾會短暫中斷，正在跑的 sandbox 指令會失敗，agent 會自己重試。
