# 開發

## 從原始碼建置 app

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

`build-android.sh` 是**開發版**：用本機的 debug keystore 簽章，所以可以反覆覆蓋安裝而不刪掉手機上的對話；WebView 遠端除錯是開著的，方便用 `test/ui.sh` 在手機上操作測試。

發布用的版本：

```sh
./scripts/release-android.sh   # 產生 pi-mobile-<package.json 版本>.apk，印出 SHA-256
```

它用 `~/.config/pi-mobile/release.env` 指定的私鑰簽章（金鑰不在 repo 裡），**關閉遠端除錯**，並從 `package.json` 帶入版本號。不同金鑰簽的 APK 不能互相覆蓋安裝，要先移除舊的（手機上的對話會一起刪掉）。

第一次打開時填：
- **模型供應商**：pi-ai 內建的供應商填 API key，或自訂端點（OpenAI 或 Anthropic 相容）填網址和 key。
- **Sandbox**（選填）：掃描 sandbox 主機安裝時印出的 QR code，見下一節。
- **GitHub**（選填）：fine-grained token，只開需要的 repo。
- **Google Cloud**（選填）：按「登入」用 Google 帳號登入。瀏覽器最後一頁會顯示授權碼，複製後回到 app 會自動帶入。流程和 `gcloud auth application-default login --no-launch-browser` 相同，用的是 gcloud 本身的 OAuth client。也可以改貼 service account 金鑰。可以設預設專案。
- **Cloudflare**（選填）：按「登入」，在瀏覽器確認代碼並同意，app 會自動完成。也可以改貼 API token。
- **Azure**（選填）：按「登入」，代碼會自動複製，在 Microsoft 的頁面貼上並同意。
- **背景執行**：允許通知，並讓 app 不受電池最佳化限制。

每一組都有「測試連線」，設定頁最下面顯示目前安裝的版本（commit 和建置時間）。

## 安裝 sandbox 主機

主機可以是 Mac（Apple silicon）或 Linux arm64，需要 Node 22+、Tailscale，以及 colima（Mac）或 rootless Docker（Linux）。在主機上執行：

```sh
sandbox/install.sh
```

這個腳本會：
- **Mac**：開一個專用的 colima VM（`pi-sandbox`，4 核、4 GB、40 GB），容器跑在這個 VM 裡，跟 Mac 本身隔了一層 VM。relay 用 launchd 在登入時啟動，log 在 `~/Library/Logs/pi-sandbox-relay.log`。
- **Linux**：用目前使用者的 rootless Docker，relay 是 systemd user service。
- 建置兩個 image：
  - `pi-sandbox`：Debian 13、Node 24（npm、pnpm）、Python 3.13 + uv、git、gh、gcloud、cf、wrangler、az、build-essential、sqlite3、ImageMagick、ffmpeg、pandoc、poppler-utils、Noto CJK 字型。
  - `pi-egress`：mitmproxy 12.2.3 加 `credentials.py`。
- 第一次安裝時在 `~/.config/pi-sandbox/env` 產生 `RELAY_TOKEN` 和 `EGRESS_SECRET`。
- 最後印出**配對 QR code** 和 `pimobile://pair?...` 連結。用手機相機掃描，pi mobile 會先測試連線、問你一次，然後自動填好設定。

再跑一次 `install.sh` 就是更新，token 會保留，不用重新配對。之後要再印一次配對碼：

```sh
node --env-file=$HOME/.config/pi-sandbox/env ~/pi-sandbox/relay/pair.mjs
```

從別台電腦安裝到遠端 Linux 主機：`sandbox/deploy.sh <ssh 目標>`，它會把 `sandbox/` 和 pi-env 複製過去再執行 `install.sh`。

## 測試

```sh
npm run check                                   # 型別檢查

# 手機上的 UI（先跑 run-android.sh 轉發 DevTools）
CDP_PORT=9333 ./test/ui.sh 'async () => { return (await window.piRuntime.bots()).map((bot) => bot.name); }'

# Sandbox 連線
SANDBOX_RELAY=ws://<主機>:8787 SANDBOX_TOKEN=... node test/sandbox-node.ts

# GitHub egress：腳本扮演手機，唯一放行的寫入是無害的 POST /markdown
SANDBOX_RELAY=ws://<主機>:8787 SANDBOX_TOKEN=... GITHUB_TOKEN=$(gh auth token) node test/egress-node.ts

# gcloud egress：腳本扮演手機並拒絕所有寫入，唯一嘗試的寫入是刪除一個不存在的 bucket
SANDBOX_RELAY=ws://<主機>:8787 SANDBOX_TOKEN=... GCLOUD_TOKEN=$(gcloud auth print-access-token) \
  GCLOUD_PROJECT=<專案> node test/gcloud-node.ts

# Cloudflare egress：同上，唯一嘗試的寫入是刪除一個不存在的 Worker
SANDBOX_RELAY=ws://<主機>:8787 SANDBOX_TOKEN=... CLOUDFLARE_TOKEN=<access token> \
  CLOUDFLARE_ACCOUNT=<account id> node test/cloudflare-node.ts
```
