# 架構


```
┌──────────────── 手機 (Capacitor WebView) ────────────────┐
│ React UI                                                  │
│ pi-durable harness ── IndexedDB（對話、執行狀態）           │
│   ├─ 模型、web_search ───── HTTPS ──▶ 模型供應商（pi-ai）   │
│   ├─ github_api、web_fetch ─ HTTPS ──▶ 網路                 │
│   ├─ code mode ──────────── Web Worker（QuickJS）           │
│   └─ coding tools ──── 手機上的 Bot 資料夾，或 WebSocket ─┐  │
│ AgentService（前景服務，背景執行）                          │  │
└────────────────────────────────────────────────────────────┼──┘
                                                 Tailscale │
┌──────────── 你的電腦（macOS、Linux）─────────────────────────┼──┐
│ pi-mobile serve：只聽 Tailscale 位址，只接受同一個使用者    ◀┘  │
│   ├─ 直接：pi-env serve，以你的帳號、從家目錄                    │
│   └─ 容器：docker exec ─▶ pim-main：pi-env serve，/workspace/<bot>│
│              bridge.py ◀── pi-mobile-egress（mitmproxy）          │
│              只攔 GitHub、Google、Cloudflare、Azure，               │
│              向手機要 token                                       │
└───────────────────────────────────────────────────────────────────┘
```

**為什麼 agent 跑在手機上？** 對話和金鑰都只在手機上，不需要一直開著的伺服器，換 sandbox 主機也不影響對話紀錄。

**為什麼用 Capacitor？** WebView 是 pi-ai 正式支援的瀏覽器環境，串流和 WASM 都能直接用。

### 電腦

pi-env 的 `Connection` 只會用 `spawn` 啟動子行程，WebView 做不到。`src/agent/sandbox/stream-connection.ts` 是它的移植版：同樣的 frame 格式和 session 語意，只是改成透過 WebSocket 傳輸。

**把電腦交給 pi**（設定 › 電腦）：
- 電腦上執行一次 `host/install.sh`，裝好常駐的 `pi-mobile serve`（`host/main.go`）。
- 它只聽這台電腦的 Tailscale 位址，用 `tailscale whois` 確認來的是同一個 Tailscale 使用者的裝置，不用 SSH、金鑰或密碼。
- 手機只要輸入電腦名稱。第一次連線時，手機把對應平台的 pi-env 上傳過去。

每個 Bot 在面板裡選一台電腦，以及它在那裡的工作方式：
- **直接**：從家目錄直接操作這台電腦，不另開資料夾；刪 Bot 不會刪電腦上的檔案。
- **容器**：電腦上有 docker、podman 或 nerdctl 時才有。手機透過 電腦上的 pi-mobile 的 `/exec` 驅動容器引擎：建好 image，所有 Bot 共用 `pim-main`，各自一個資料夾。egress proxy 透過另一條 `/exec` 通道上的 `bridge.py` 向手機要 token，所以憑證只在手機上。

設計見 [design/computer-host.md](design/computer-host.md)。

### 憑證與 egress proxy

每個 sandbox 的 HTTP(S) 流量都經過 `pi-egress`（mitmproxy + `sandbox/egress/credentials.py`）。它只攔下表裡的主機，其他網站（pip、npm、apt）直接放行、不解密。Proxy 的 CA 在容器第一次連線時裝進去。

| | GitHub | Google Cloud | Cloudflare | Azure |
|---|---|---|---|---|
| 攔截的主機 | `github.com`、`api.github.com`、`uploads.github.com`、`raw.githubusercontent.com` | `*.googleapis.com` | `api.cloudflare.com` | `management.azure.com`、`graph.microsoft.com`、`*.vault.azure.net`、Storage |
| 容器裡的佔位 | `GH_TOKEN` | `gcloud` 的 `auth/access_token_file` | `CLOUDFLARE_API_TOKEN`（`cf`、`wrangler` 都用它） | `az login --identity`：bridge 扮演 managed identity 端點，發格式正確、沒有效力的 JWT |
| 登入方式 | 貼 fine-grained token | App 內 Google 登入，或貼 service account 金鑰 | App 內 Cloudflare 登入（`cf` 的 device flow），或貼 API token | App 內 Microsoft device code（az 的公開 client），代碼自動複製 |
| 真的憑證在哪 | 手機 Keystore；proxy 每次需要時透過 bridge 向手機要，不留在電腦上 | 長期憑證**只在手機上**；proxy 需要時請手機換一個短效 access token | 同 Google Cloud；refresh token 每次換新都會寫回 Keystore | 同 Cloudflare；每個 Azure 資源（ARM、Graph、Key Vault、Storage）各換一個 token |

Sandbox 裡設了 `NODE_USE_ENV_PROXY=1`：Node 24 內建的 `fetch` 預設不走 `HTTPS_PROXY`，不設的話 `cf` 這類工具會繞過 proxy。

讀取和寫入都直接帶上憑證，不會先問。手機沒連上時，GitHub 的請求不帶憑證送出，其他服務回 `pi mobile: 手機沒有連上…`。

**登入用的 OAuth client**：Google、Cloudflare、Azure 的 app 內登入，借用的是各家官方 CLI 公開發布的 client（`gcloud auth application-default login`、`cf auth login`、`az login` 用的同一組），所以同意頁上顯示的是那些 CLI 的名稱。這讓你不用自己去各家註冊 OAuth app；代價是哪天供應商限制這些 client，登入就可能失效。

## 專案結構

每個檔案開頭的註解說明它做什麼；這裡只列從哪裡找起。

| 路徑 | 內容 |
|---|---|
| `src/agent/runtime.ts` | `AgentRuntime`：harness、Bot 清單、每個 Bot 的控制器、執行狀態 |
| `src/agent/catalog.ts` | 內建工具的唯一清單；工具的寫法見 [tools.md](tools.md) § 介面規範 |
| `src/agent/tools/` | 內建工具，一個領域一個檔案；`common.ts` 是共用的 `defineAppTool` |
| `src/agent/codemode.ts`、`on-demand.ts`、`toolsets.ts` | Code mode（QuickJS Web Worker）、需要時才載入的工具、Bot 可選的工具組 |
| `src/agent/bots.ts`、`memory.ts`、`triggers.ts`、`skills.ts` | Bot 的資料與系統提示、MEMORY.md、排程、技能 |
| `src/agent/providers.ts`、`models.ts`、`credentials.ts`、`chatgpt.ts` | 模型供應商、自訂端點、金鑰、ChatGPT 登入 |
| `src/agent/mcp.ts`、`mcp-catalog.ts` | MCP 服務（含 OAuth）與服務市集 |
| `src/agent/gcloud.ts`、`cloudflare.ts`、`azure.ts`、`oauth.ts` | 三家雲端的登入與憑證 |
| `src/agent/attachments*.ts` | 附件：PDF、Word、試算表、圖片 |
| `src/agent/files/` | 沒有電腦時，Bot 在手機上的資料夾和 bash（just-bash Web Worker） |
| `src/agent/computers.ts`、`src/agent/sandbox/` | Bot 在哪台電腦工作：直接或容器、pi-env 的 frame 協定、檔案與 git |
| `src/agent/parse.ts` | 邊界驗證（typebox） |
| `src/storage.ts`、`src/idb.ts`、`src/settings.ts` | pi-durable 的 IndexedDB 儲存、其他 IndexedDB 資料、設定（密鑰在 Keystore） |
| `src/*-plugin.ts` | 原生 plugin 的 TypeScript 介面，各自對應 `android/.../<名稱>Plugin.java` |
| `src/shims/` | 讓 pi-env 的 Node import 能在瀏覽器打包 |
| `src/app/` | React UI |
| `android/app/src/main/java/dev/geminixiang/pimobile/` | 原生功能：前景服務、plugin、排程、通知、數位助理 |
| `host/` | 電腦上的 `pi-mobile`（Go）：`serve`、`mcp computer`，與安裝腳本 |
| `sandbox/` | 容器的 image 和 egress proxy（app 透過電腦上的 pi-mobile 建置） |
| `scripts/` | Android 建置（開發版、發布版）與安裝、圖示產生 |
| `test/` | 手機上的 UI 測試（CDP）、工具介面的檢查 |
