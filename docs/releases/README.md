# 發布

1. `package.json` 的 `version` 改成新版本（`package-lock.json` 也一起），寫 `docs/releases/<version>.md`。
2. 推上 `main`，再推 tag `v<version>`。
3. `.github/workflows/release.yml` 檢查、建置簽章 APK，建立 GitHub release，附上 APK 和兩個 SHA-256。

金鑰放在 repo 的 Actions secrets：`PI_MOBILE_KEYSTORE_BASE64`、`PI_MOBILE_KEYSTORE_PASSWORD`、`PI_MOBILE_KEY_ALIAS`。在本機也能用 `scripts/release-android.sh` 建置。
