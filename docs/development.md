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

`build-android.sh` 是**開發版**：WebView 遠端除錯是開著的，方便用 `test/ui.sh` 在手機上操作測試。有發布金鑰（`~/.config/pi-mobile/release.env`）時，它用發布金鑰簽章、版本號跟 `package.json` 一樣（名稱加 `-dev`），所以開發版和正式版可以互相覆蓋安裝，不刪手機上的資料；沒有金鑰時用本機的 debug keystore，這樣的開發版和正式版不能互相覆蓋，換的時候要先移除，資料會一起清掉。

發布用的版本：

```sh
./scripts/release-android.sh   # 產生 pi-mobile-<package.json 版本>.apk，印出 SHA-256
```

它用 `~/.config/pi-mobile/release.env` 指定的私鑰簽章（金鑰不在 repo 裡），**關閉遠端除錯**，並從 `package.json` 帶入版本號。不同金鑰簽的 APK 不能互相覆蓋安裝，要先移除舊的（手機上的對話會一起刪掉）。

第一次打開時填：
- **模型供應商**：pi-ai 內建的供應商填 API key，或自訂端點（OpenAI 或 Anthropic 相容）填網址和 key。
- **電腦**（選填）：把 tailnet 裡的一台電腦交給 pi，見下一節。
- **GitHub**（選填）：fine-grained token，只開需要的 repo。
- **Google Cloud**（選填）：按「登入」用 Google 帳號登入。瀏覽器最後一頁會顯示授權碼，複製後回到 app 會自動帶入。流程和 `gcloud auth application-default login --no-launch-browser` 相同，用的是 gcloud 本身的 OAuth client。也可以改貼 service account 金鑰。可以設預設專案。
- **Cloudflare**（選填）：按「登入」，在瀏覽器確認代碼並同意，app 會自動完成。也可以改貼 API token。
- **Azure**（選填）：按「登入」，代碼會自動複製，在 Microsoft 的頁面貼上並同意。
- **背景執行**：允許通知，並讓 app 不受電池最佳化限制。

每一組都有「測試連線」，設定頁最下面顯示目前安裝的版本（commit 和建置時間）。

## 把電腦交給 pi

電腦（macOS，或有 systemd 的 Linux）要裝好 Tailscale，並登入跟手機同一個帳號。在電腦上執行一次：

```sh
curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh
```

它會安裝 `pi-mobile`，並設定成登入時自動執行 `pi-mobile serve`。之後可以用 `~/.pi/mobile/bin/pi-mobile status` 確認它有沒有在跑。最後印出一個名稱，到手機的設定 › 電腦輸入它。

- **直接**：Bot 以你的帳號、從家目錄操作這台電腦。
- **容器**：電腦上有 docker、podman 或 nerdctl 時才會出現。第一次按下時會在電腦上建好兩個 image：
  - `pi-mobile/sandbox`：Debian 13、Node 24（npm、pnpm）、Python 3.13 + uv、git、gh、gcloud、cf、wrangler、az、build-essential、sqlite3、ImageMagick、ffmpeg、pandoc、poppler-utils、Noto CJK 字型。
  - `pi-mobile/egress`：mitmproxy 加上 `credentials.py`。

  所有 Bot 共用 `pim-main` 這個容器。憑證只留在手機上。

設計見 [design/computer-host.md](design/computer-host.md)。開發電腦上的 pi-mobile：

```sh
cd host && go build -o /tmp/pi-mobile-darwin-arm64 . && PI_MOBILE_URL=file:///tmp/pi-mobile-darwin-arm64 sh install.sh
```

移除：`sh host/install.sh uninstall`。

## 測試

```sh
npm run check                                   # 型別檢查

# 手機上的 UI（先跑 run-android.sh 轉發 DevTools）
CDP_PORT=9333 ./test/ui.sh 'async () => { return (await window.piRuntime.bots()).map((bot) => bot.name); }'
```

### 效能量測（120 Hz）

只在 S24 上量；模擬器的 vsync、GPU、CPU 都不是手機的，數字只能拿來驗證腳本。

```sh
node test/perf/server.ts &                                  # 固定輸出的模型（localhost:8399）
node test/perf/fixture.ts setup <serial>                    # 測試 provider、「測試效能」Bot、30 則固定回答
node test/perf/run.ts --serial <serial> --label before     # 5 個場景，各暖機 1 次、量 5 次，取中位數
node test/perf/run.ts --serial <serial> --label after --compare test/perf/out/before.json
node test/perf/fixture.ts teardown <serial>                 # 移除 Bot、provider 和它的 key
```

- 場景：`scroll`（往上 3 次、往下 3 次 fling）、`stream`（停在底部串流約 10,000 字、42 秒，每 150 ms 一批）、`streamscroll`（串流中來回捲）、`typing`（輸入框打 30 個字）、`panel`（側欄開關 3 次）。`--scenes` 可以只跑其中幾個。
- 一幀的預算是 8.33 ms，超過 1.5 個 vsync（12.5 ms）就算掉幀。`gfx*` 來自 `dumpsys gfxinfo`，是畫面實際送出的幀，包含 compositor 和 GPU；`raf*`、`loaf*`、`input*` 是頁面的主執行緒（rAF 間隔、Long Animation Frames、Event Timing），用來找原因。
- 頁面不在 120 Hz、開著的不是測試 Bot 時，`run.ts` 拒絕量。每一次量之前，熱狀態要是 0、AP 不超過 50°C，不然就等（`PERF_MAX_THERMAL_STATUS`、`PERF_MAX_AP`）。充電時手機比較熱，量要比較的數字前先拔掉。
- `typing` 時沒有動畫，Samsung 會把更新率降到 60 Hz，所以只看 `inputP95`。
- 每次 `stream` 都會在對話留下一則回答，DOM 越跑越大（每次約 +230 個節點，記在每一輪的 `nodes`）。比較前後時，兩邊都先 `teardown` 再 `setup`。

### 手機 Git inspection 草稿回歸

`node --import ./test/vite-imports.js test/bash/git-inspection.ts` 已接入 `npm run check`，使用記憶體 VFS 與禁止網路的 fixture。此草稿由無 Node/npm 的手機編寫，尚未執行；不能以已安裝 0.5.0 的命令結果代表新原始碼已通過。支援形式、公開 API 來源及仍未實作的 `ls-remote` 見 [research/phone-git-inspection.md](research/phone-git-inspection.md)。
