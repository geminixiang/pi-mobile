<p align="center"><img src="assets/icon.svg" width="96" alt="pi mobile"></p>

<h1 align="center">pi mobile</h1>

<p align="center"><b>非官方的社群專案</b>：不是 <a href="https://pi.dev">pi</a> 官方產品，與 Earendil 沒有關聯，也沒有經過他們背書。</p>

<p align="center">AI agent 直接跑在你的 Android 手機上：<br>用你自己的模型 key，資料留在手機，程式碼在你自己的電腦上執行。</p>

<p align="center">
<img src="docs/screenshots/home.png" width="200" alt="首頁">
<img src="docs/screenshots/chat.png" width="200" alt="對話：在 sandbox 畫圖">
<img src="docs/screenshots/changes.png" width="200" alt="工作區：git 變更">
<img src="docs/screenshots/diff.png" width="200" alt="工作區：diff">
</p>

- **幾個長期的 Bot**：每個 Bot 有自己的名字、工作說明、記憶、排程，和一條一直延續的對話，太長時自動壓縮。
- **Agent 在手機上跑**：對話和執行狀態存在手機上。鎖屏、切到背景都會繼續跑，app 被系統清掉後也會接著跑。
- **模型用你自己的 key**：任何 OpenAI 或 Anthropic 相容的 API 都能接。
- **手機的能力**：天氣、附近的店家、行事曆、通知、鬧鐘、語音、記帳用的 SQLite 資料庫……都是工具，每個 Bot 可以分別開關。
- **連接服務（MCP）**：從精選清單一鍵連接 Notion、Linear、Todoist、Stripe、Sentry 等服務，登入在瀏覽器完成。
- **Sandbox 在你的電腦上**：用 SSH 連 tailnet 上的 Mac 或 Linux，Bot 在容器裡讀寫檔案、跑指令。
- **寫入都要你同意**：GitHub、雲端、MCP 服務的寫入，以及刪除資料，都要在手機上按「允許」。憑證只在手機上，不進 sandbox。

> 這是個人專案，還在早期。它會用你的帳號做事，請先讀[安全模型](docs/security.md)。

## 開始使用

1. **安裝**：從 [Releases](../../releases) 下載 APK 安裝。需要 Android 7.0 以上的 arm64 手機。
2. **填模型服務**：第一次打開時，填上 API 網址和 key。到這一步就能聊天和搜尋網路。
3. **（選用）** 在設定裡連接 GitHub、雲端帳號、MCP 服務，或用 SSH 加入你的電腦當 sandbox。
4. **背景執行**：在設定 › 背景執行允許通知，並讓 app 不受電池最佳化限制。

## 文件

- [功能細節](docs/features.md)：Bot、記憶、排程與耳機觸發、工具、工作區、操作手勢
- [工具與 context](docs/tools.md)：每組工具佔多少提示、常駐或需要時載入、MCP 服務市集、新工具上線前的量測
- [架構](docs/architecture.md)：手機與 sandbox 怎麼連、憑證與 egress proxy、專案結構
- [開發](docs/development.md)：從原始碼建置、安裝 sandbox 主機、測試
- [安全模型與已知限制](docs/security.md)
- 設計文件：[排程與觸發](docs/design/triggers.md)、[SSH sandbox](docs/design/sandbox-ssh.md)

## 關於這個專案

pi mobile 是非官方的社群專案，與 [pi](https://pi.dev) 的開發者 Earendil 沒有任何關聯。它使用 npm 上公開發布的 pi 套件（`@earendil-works/pi-durable`、`pi-ai`、`pi-env`、`pi-mcp`、`pi-codemode`、`chord`）。問題和建議請開在這個 repo，不要回報給 pi 官方。App 圖示沿用 pi 標誌的像素形狀，改用 pi.dev 網站的配色，以示致敬。

## 授權

[MIT](LICENSE)。
