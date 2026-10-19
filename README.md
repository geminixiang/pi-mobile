<p align="center"><img src="assets/icon.svg" width="96" alt="pi mobile"></p>

# pi mobile

把 agent 放進口袋：一個在手機上直接跑 agent loop 的 Android app，給自己用。

- **Agent 在手機上跑**：用 [pi-durable](https://pi.dev) 的 harness，對話、執行狀態都存在手機的 SQLite。App 被殺掉或背景回收，下次打開會從中斷的地方繼續。
- **模型用自己的 key**：透過自架的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（OpenAI 相容），key 存在 Android Keystore。
- **Sandbox 在自己的機器上**：每個對話有一個獨立的 Linux 容器（目前跑在 Mac mini 的 colima VM 裡），agent 的 `read`、`write`、`edit`、`bash` 都在那裡執行，不在手機上。
- **GitHub 連接器**：REST API 工具，加上 sandbox 裡已登入的 `git` 和 `gh`。所有寫入都要你在手機上按「允許」。

UI 是 React，介面文字是繁體中文，視覺語言沿用 [pi.dev](https://pi.dev)。

## 架構

```
┌──────────── 手機 (Capacitor WebView) ────────────┐
│ React UI                                          │
│ pi-durable harness ── SQLite (對話、執行狀態)        │
│   ├─ 模型 ──────────── HTTPS ──▶ CLIProxyAPI        │
│   ├─ github_api ────── HTTPS ──▶ api.github.com    │
│   └─ coding tools ──── WebSocket ─┐                 │
│ EgressLink (token、寫入核准) ── WS ─┤                │
└────────────────────────────────────┼─────────────────┘
                                     │ Tailscale
┌──────────── Mac mini (colima VM) ────┼─────────────────┐
│ relay (server.mjs) ◀────────────────┘                 │
│   ├─ docker exec ─▶ sbx-c<id>: pi-env serve, /workspace │
│   └─ /egress/authorize ◀─ pi-egress (mitmproxy)        │
│                            └─ 只攔 GitHub，注入 token ──▶ github.com │
└───────────────────────────────────────────────────────┘
```

**為什麼 agent 跑在手機上？** 對話和金鑰只在手機上；不需要一直開著的伺服器；換一台 sandbox 主機不影響對話紀錄。代價是長任務受 Android 背景限制，也就是 app 在背景太久會被暫停，回到前景後才繼續。

**為什麼用 Capacitor？** WebView 是 pi-ai 正式支援的瀏覽器環境，串流、WASM 都能直接用。

### Sandbox 連線

pi-env 的 `Connection` 只會用 `spawn` 啟動子行程，WebView 做不到。`src/agent/sandbox/ws-connection.ts` 是它的移植版：同樣的 frame 格式和 session 語意，只是傳輸改成 WebSocket。

Relay 收到連線後，確保容器存在且在執行，再跑 `docker exec -i <container> pi-env serve`，兩邊照搬 bytes，不解析 frame。容器第一次連線時才建立，閒置 30 分鐘後停止，檔案留在 volume 裡。同時最多跑 6 個容器，滿了會停掉最久沒用的那個。

### GitHub 與 sandbox

Token 不會進到 sandbox：

1. 每個 sandbox 的 HTTP(S) 流量都經過 `pi-egress`（mitmproxy）。它只攔 `github.com`、`api.github.com`、`uploads.github.com`、`raw.githubusercontent.com`，其他網站直接放行，不解密。
2. 手機透過 relay 的 `/control` WebSocket 把 token 交給 relay。Token 只放在 relay 的記憶體裡，手機斷線 10 分鐘後丟掉。
3. Addon 對每個 GitHub 請求問 relay 要 token：
   - **讀取**（clone、fetch、REST GET、GraphQL query）直接放行。
   - **寫入**（`git push`、REST 的 POST/PATCH/PUT/DELETE、GraphQL mutation、LFS 上傳）先停住，relay 把請求轉到手機的確認框，你按「允許」才送出。拒絕時 git 和 gh 會顯示 `pi mobile: 使用者拒絕了這個寫入`。
4. Sandbox 裡的 `GH_TOKEN` 只是佔位字串，mitmproxy 的 CA 在第一次連線時裝進容器。

## 功能

- 多個對話，抽屜依日期分組，可以搜尋、重新命名、刪除。
- 模型和思考強度選單，模型清單取自 CLIProxyAPI 的 `/v1/models`。
- Agent 工作時可以「插話」（插到下一輪工具之後）或「稍後」（等這次跑完）。排隊的訊息可以撤回；按停止時，排隊的訊息會放回輸入框。
- 從任一則你的訊息「分支」開新對話。
- 壓縮對話、開始新的上下文、上下文用量和 token 統計。
- 圖片輸入、Markdown 回答、工具步驟即時輸出，思考過程可以收合。
- **Code mode**：模型可以寫 JavaScript，在一個腳本裡批次呼叫工具（`tools.<name>(args)`）、整理資料。腳本在手機上的 QuickJS VM 裡跑，用的是 pi-durable 的 `codemode` 工具，每個結果都先記下來，app 被殺掉後會接著跑。VM 放在 Web Worker 裡，腳本在計算時 UI 不會卡住。
- **工作區**：瀏覽 sandbox 的 `/workspace`、看檔案（行號、Markdown 預覽、圖片）、每個 git repo 的變更、diff 和最近的 commit。工具步驟上的檔案圖示會直接打開那個檔案。
- Android 返回手勢依序關閉最上層的畫面；什麼都沒開時，app 退到背景，不會被關掉。

## 專案結構

| 路徑 | 內容 |
|---|---|
| `src/agent/runtime.ts` | `AgentRuntime`：harness、對話索引、每個對話的控制器 |
| `src/agent/models.ts` | CLIProxyAPI provider：Claude 走 anthropic-messages，gpt-5.6/gpt-6 走 openai-responses，其他走 openai-completions |
| `src/agent/tools/` | `device_info`、`github_api`、`github_read_file` |
| `src/agent/codemode.ts`、`codemode-worker.ts` | Code mode：`RemoteCodemodeSandbox` 的 remote 是一個跑 `serveCodemodeRemote` 的 Web Worker |
| `src/agent/sandbox/` | `ws-connection.ts`（pi-env over WebSocket）、`sandbox.ts`（每個對話的 env）、`egress.ts`（控制通道）、`workspace.ts`（檔案與 git） |
| `src/storage.ts` | pi-durable 的 SQLite adapter（Capacitor SQLite，WAL） |
| `src/settings.ts` | 設定；密鑰存在 Keystore |
| `src/shims/` | 讓 pi-env 的 Node import 能在瀏覽器打包 |
| `src/app/` | React UI |
| `sandbox/` | Sandbox 主機端：image、relay、egress proxy、安裝腳本 |
| `scripts/` | Android 建置與安裝、圖示產生 |
| `test/` | 裝置上的 UI 測試（CDP）、sandbox 和 egress 的 Node 端到端測試 |

## 建置與安裝

需要：
- Node 24
- JDK 21：Capacitor 8 / AGP 8.13 要求，腳本預設用 Homebrew 的 `openjdk@21`。
- Android SDK（platform 36、build-tools 36），裝在 `~/Library/Android/sdk`。
- 開了 USB 或無線偵錯的 Android 手機。

```sh
npm ci --ignore-scripts
./scripts/build-android.sh            # 產生 pi-mobile.apk（release、R8 壓縮，只含 arm64）
./scripts/run-android.sh <adb serial> # 安裝、重開 app、轉發 WebView DevTools
```

Release 版用本機的 debug keystore 簽章，所以可以直接覆蓋安裝，不會刪掉手機上的對話。WebView 遠端除錯是開著的，方便用 `test/ui.sh` 在手機上操作測試。

第一次打開時填：
- **模型服務**：CLIProxyAPI 的 URL 和 API key。
- **GitHub**（選填）：fine-grained token，只開需要的 repo。
- **Sandbox**（選填）：掃描 sandbox 主機安裝時印出的 QR code，見下一節。

每一組都有「測試連線」按鈕。

## 安裝 sandbox 主機

主機可以是 Mac（Apple silicon）或 Linux arm64，需要 Node 22+、Tailscale，以及 colima（Mac）或 rootless Docker（Linux）。在主機上執行：

```sh
sandbox/install.sh
```

這個腳本會：
- **Mac**：開一個專用的 colima VM（`pi-sandbox`，4 核、4 GB、40 GB），容器跑在這個 VM 裡，跟 Mac 本身隔了一層 VM。relay 用 launchd 在登入時啟動，log 在 `~/Library/Logs/pi-sandbox-relay.log`。
- **Linux**：用目前使用者的 rootless Docker，relay 是 systemd user service。
- 建置 `pi-sandbox`（Debian 13、Node 24、Python 3.13 + uv、pnpm、git、gh、sqlite3、ImageMagick、ffmpeg、pandoc、Noto CJK 字型等）和 `pi-egress`（mitmproxy 12.2.3 加 addon）兩個 image。
- 第一次安裝時在 `~/.config/pi-sandbox/env` 產生 `RELAY_TOKEN` 和 `EGRESS_SECRET`。
- 最後印出**配對 QR code** 和 `pimobile://pair?...` 連結。用手機相機掃描，pi mobile 會先測試連線、問你一次，然後自動填好設定。

之後要再印一次配對碼：

```sh
node --env-file=$HOME/.config/pi-sandbox/env ~/pi-sandbox/relay/pair.mjs
```

從別台電腦安裝到遠端 Linux 主機：`sandbox/deploy.sh <ssh 目標>`，它會把 `sandbox/` 和 pi-env 複製過去再執行 `install.sh`。

## 測試

```sh
npm run check                                   # 型別檢查

# 手機上的 UI（先跑 run-android.sh 轉發 DevTools）
CDP_PORT=9333 ./test/ui.sh 'async () => { click("新對話"); return messages(); }'

# Sandbox 連線
SANDBOX_RELAY=ws://<主機>:8787 SANDBOX_TOKEN=... node test/sandbox-node.ts

# GitHub egress：這支腳本扮演手機，唯一放行的寫入是無害的 POST /markdown
SANDBOX_RELAY=ws://<主機>:8787 SANDBOX_TOKEN=... GITHUB_TOKEN=$(gh auth token) node test/egress-node.ts
```

## 安全模型

| 資料 | 存放位置 |
|---|---|
| 對話、執行狀態 | 手機的 SQLite（未加密，`allowBackup=false`，不會進雲端備份） |
| CLIProxyAPI key、GitHub token、relay token | Android Keystore（`capacitor-secure-storage`） |
| GitHub token（sandbox 用） | 手機連線期間（加 10 分鐘）在 relay 的記憶體；不進容器、不寫進主機硬碟 |
| Sandbox 檔案 | 主機上每個對話一個 Docker volume；重置 sandbox 會刪除 |

- 所有 GitHub 寫入都要在手機上核准，包括 `github_api` 工具和 sandbox 裡的 git、gh。
- App 允許明文 HTTP（`network_security_config.xml`），因為 CLIProxyAPI 和 relay 只透過 Tailscale 連線。
- 能登入主機 `agent` 帳號的人可以讀到 relay 記憶體裡的 GitHub token，以及 egress 的 CA 私鑰。

## 已知限制

- 只有 Android，iOS 需要 Xcode 和 Apple Team ID，還沒做。
- Sandbox image 只有 arm64（打包 `pi-env-linux-arm64`）。
- Sandbox 沒有互動式終端機（PTY），vim、REPL 這類程式不能用。
- 無線偵錯的 port 每次重開都會變。
