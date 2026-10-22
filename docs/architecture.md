# 架構


```
┌──────────────── 手機 (Capacitor WebView) ────────────────┐
│ React UI                                                  │
│ pi-durable harness ── IndexedDB（對話、執行狀態）           │
│   ├─ 模型、web_search ───── HTTPS ──▶ 模型供應商（pi-ai）   │
│   ├─ github_api、web_fetch ─ HTTPS ──▶ 網路                 │
│   ├─ code mode ──────────── Web Worker（QuickJS）           │
│   └─ coding tools ───────── WebSocket ─┐                    │
│ EgressLink（token、寫入核准）── WebSocket ┤                    │
│ AgentService（前景服務，背景執行）          │                    │
└──────────────────────────────────────────┼───────────────────┘
                                           │ Tailscale
┌───────── Sandbox 主機（Mac：colima VM；Linux：rootless Docker）┐
│ relay (server.js) ◀─────────────────────┘                   │
│   ├─ docker exec ─▶ sbx-main：pi-env serve，/workspace/<bot>   │
│   └─ /egress/authorize ◀── pi-egress（mitmproxy）              │
│                    只攔 GitHub、Google、Cloudflare、Azure， │
│                              換上真的 token，寫入先問手機       │
└────────────────────────────────────────────────────────────────┘
```

**為什麼 agent 跑在手機上？** 對話和金鑰都只在手機上，不需要一直開著的伺服器，換 sandbox 主機也不影響對話紀錄。

**為什麼用 Capacitor？** WebView 是 pi-ai 正式支援的瀏覽器環境，串流和 WASM 都能直接用。

### Sandbox 連線

pi-env 的 `Connection` 只會用 `spawn` 啟動子行程，WebView 做不到。`src/agent/sandbox/ws-connection.ts` 是它的移植版：同樣的 frame 格式和 session 語意，只是傳輸改成 WebSocket。

Relay 收到連線後，確保容器存在且在執行，再跑 `docker exec -i <container> pi-env serve`，兩邊照搬 bytes，不解析 frame。容器第一次連線時才建立，閒置 30 分鐘後停止，檔案留在 volume 裡。

**用 SSH 連機器**（設定 › 機器）：手機用自己的 Ed25519 金鑰（ConnectBot sshlib）連上 tailnet 上的 Mac 或 Linux，上傳對應架構的 `pi-env` 到 `~/.pi/env/<sha>/`，之後每個工具呼叫都走同一條 SSH 連線，主機上不用裝 relay。主機有 nerdctl、podman 或 docker 時用**容器模式**：在主機上建好 image，所有 Bot 共用容器 `pim-main`，egress proxy 透過一條 SSH exec 通道向手機要 token 和寫入核准，跟 relay 一樣，憑證只在手機上。沒有容器引擎時用**直接模式**，在 `~/pi-workspaces/<bot>` 裡以你的帳號執行，設定頁會清楚標示。設計見 [design/sandbox-ssh.md](design/sandbox-ssh.md)。

### 憑證與 egress proxy

每個 sandbox 的 HTTP(S) 流量都經過 `pi-egress`（mitmproxy + `sandbox/egress/credentials.py`）。它只攔下表裡的主機，其他網站（pip、npm、apt）直接放行、不解密。Proxy 的 CA 在容器第一次連線時裝進去。

| | GitHub | Google Cloud | Cloudflare | Azure |
|---|---|---|---|---|
| 攔截的主機 | `github.com`、`api.github.com`、`uploads.github.com`、`raw.githubusercontent.com` | `*.googleapis.com` | `api.cloudflare.com` | `management.azure.com`、`graph.microsoft.com`、`*.vault.azure.net`、Storage |
| 容器裡的佔位 | `GH_TOKEN` | `gcloud` 的 `auth/access_token_file` | `CLOUDFLARE_API_TOKEN`（`cf`、`wrangler` 都用它） | `az login --identity`：relay 扮演 managed identity 端點，發格式正確、沒有效力的 JWT |
| 登入方式 | 貼 fine-grained token | App 內 Google 登入，或貼 service account 金鑰 | App 內 Cloudflare 登入（`cf` 的 device flow），或貼 API token | App 內 Microsoft device code（az 的公開 client），代碼自動複製 |
| 真的憑證在哪 | 手機 Keystore；連線時交給 relay，只放記憶體，手機斷線 10 分鐘後丟掉 | 長期憑證**只在手機上**；relay 需要時請手機換一個短效 access token | 同 Google Cloud；refresh token 每次換新都會寫回 Keystore | 同 Cloudflare；每個 Azure 資源（ARM、Graph、Key Vault、Storage）各換一個 token |
| 直接放行（讀取） | clone、fetch、REST GET、GraphQL query | GET，以及只讀的 POST（`:list`、`:search`、`:get`、`:testIamPermissions` 等） | GET、GraphQL 分析 API | GET、Resource Graph 查詢、名稱檢查 |
| 要你核准（寫入） | `git push`、REST 的 POST/PATCH/PUT/DELETE、GraphQL mutation、LFS 上傳 | 其他所有請求 | 其他所有請求 | 其他所有請求，包括會回傳金鑰的 `listKeys` |

Sandbox 裡設了 `NODE_USE_ENV_PROXY=1`：Node 24 內建的 `fetch` 預設不走 `HTTPS_PROXY`，不設的話 `cf` 這類工具會繞過 proxy。

被拒絕時，git、gh、gcloud、cf、wrangler、az 都會顯示 `pi mobile: 使用者拒絕了這個寫入`。手機沒連上時，讀取不帶憑證送出，寫入一律拒絕。

**登入用的 OAuth client**：Google、Cloudflare、Azure 的 app 內登入，借用的是各家官方 CLI 公開發布的 client（`gcloud auth application-default login`、`cf auth login`、`az login` 用的同一組），所以同意頁上顯示的是那些 CLI 的名稱。這讓你不用自己去各家註冊 OAuth app；代價是哪天供應商限制這些 client，登入就可能失效。

## 專案結構

| 路徑 | 內容 |
|---|---|
| `src/agent/runtime.ts` | `AgentRuntime`：harness、Bot 清單、每個 Bot 的控制器、執行狀態（task graph） |
| `src/agent/bots.ts`、`memory.ts`、`triggers.ts` | Bot 的資料與系統提示、全域和 Bot 的記憶、排程 |
| `src/agent/providers.ts`、`credentials.ts`、`models.ts` | 模型供應商：pi-ai 內建的供應商（各自一個 chunk，用到才載入）、API key 的 credential store；自訂端點的 provider（Claude 走 anthropic-messages，gpt-5.6/gpt-6 走 openai-responses，其他走 openai-completions，規格查 pi-ai 的目錄） |
| `src/agent/tools/` | `device.ts`（`device_info`、`get_location`、`read_sensors`、`get_travel_time`）、`github_api`、`github_read_file`、`web_search`、`web_fetch`；`apps.ts` 是交給其他 app 的工具（Intent），`calendar.ts` 是行事曆（權限設定在 `src/agent/calendar-access.ts`） |
| `src/agent/codemode.ts`、`codemode-worker.ts` | Code mode：`RemoteCodemodeSandbox` 的 remote 是一個跑 `serveCodemodeRemote` 的 Web Worker |
| `src/agent/parse.ts`、`oauth.ts` | 邊界驗證（typebox schema）與三家雲端共用的 OAuth：原生 HTTP 加逾時、token 回應、device flow 輪詢 |
| `src/agent/gcloud.ts` | Google 憑證：app 內登入（PKCE）、refresh token 換 access token，或用 WebCrypto 簽 service account 的 JWT |
| `src/agent/cloudflare.ts` | Cloudflare 憑證：device flow 登入、refresh token 輪替 |
| `src/agent/azure.ts` | Azure 憑證：Microsoft device code 登入、每個資源各自換 token |
| `src/agent/sandbox/` | `stream-connection.ts`（pi-env 的 frame 協定），`ws-connection.ts`、`ssh.ts`（WebSocket 和 SSH 兩種傳輸）、`machine.ts`、`container.ts`（SSH 機器的安裝和容器）、`sandbox.ts`（共用的 sandbox 和每個 Bot 的資料夾）、`egress.ts`（控制通道）、`workspace.ts`（檔案與 git） |
| `src/storage.ts` | pi-durable 的 IndexedDB 儲存，用 Web Lock 確保只有一個擁有者；只為了讀 v0.1.0 的舊資料庫保留 SQLite |
| `src/settings.ts` | 設定；密鑰存在 Keystore |
| `src/shims/` | 讓 pi-env 的 Node import 能在瀏覽器打包 |
| `src/app/` | React UI；`docs.ts` 以 pi-durable 的文件 token 型別讀取對話狀態；`keepAlive.ts`、`voice.ts`、`pairing.ts` 是對應 Android 原生功能的那一層 |
| `android/.../AgentService.java`、`KeepAlivePlugin.java`、`VoicePlugin.java`、`AppsPlugin.java`、`CalendarPlugin.java`、`PhonePlugin.java`、`TriggersPlugin.java`、`SshPlugin.java` | 前景服務與通知、語音辨識、用 Intent 交給其他 app、行事曆、位置與感測器、排程與分享、SSH |
| `sandbox/` | Sandbox 主機端：image、relay、egress proxy、安裝腳本 |
| `scripts/` | Android 建置（開發版、發布版）與安裝、圖示產生 |
| `test/` | 手機上的 UI 測試（CDP）、sandbox、GitHub 和 gcloud egress 的 Node 端到端測試 |
