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

  所有 Bot 共用 `pim-main` 這個容器。憑證只留在手機上，寫入要先在手機上核准。

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
