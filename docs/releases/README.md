# 發布

1. `package.json` 的 `version` 改成新版本（`package-lock.json` 也一起），寫 `docs/releases/<version>.md`。
2. 推上 `main`，再推 tag `v<version>`。
3. `.github/workflows/release.yml` 從那個 commit 建出兩邊，放進同一個 GitHub release，並設成 latest：
   - **App**：檢查（`npm run check`）、建置簽章 APK `pi-mobile-<version>.apk`。
   - **電腦端**：`go vet`、`go test`，建出 macOS、Linux（arm64、x64）的 `pi-mobile-<os>-<arch>`，加上 `pi-mobile.icns`。
   - 所有檔案的 SHA-256 寫進 `pi-mobile.sha256`；release 說明附上 APK 和簽章憑證的 SHA-256。

使用者拿到的方式：
- **手機**：從 release 下載 APK。用同一把金鑰簽章，可以直接覆蓋安裝舊版。
- **電腦**：`curl -fsSL https://raw.githubusercontent.com/geminixiang/pi-mobile/main/host/install.sh | sh`。它從最新的 release 下載對應平台的 `pi-mobile` 和圖示，比對 `pi-mobile.sha256`。更新也是同一行；macOS 上權限會保留（`docs/design/computer-host.md`）。

金鑰放在 repo 的 Actions secrets：`PI_MOBILE_KEYSTORE_BASE64`、`PI_MOBILE_KEYSTORE_PASSWORD`、`PI_MOBILE_KEY_ALIAS`。在本機也能用 `scripts/release-android.sh` 建 APK。
